package main

import (
	"fmt"
	"io"
	"log"
	"sync"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
)

type WebRTCManager struct {
	mu           sync.RWMutex
	streams      map[string]*webrtc.TrackLocalStaticRTP
	streamerPC   map[string]*webrtc.PeerConnection // Simpan PC milik streamer untuk kirim PLI
	streamerSSRC map[string]webrtc.SSRC            // Simpan SSRC track streamer
	webrtcAPI    *webrtc.API
}

func NewWebRTCManager() *WebRTCManager {
	mediaEngine := &webrtc.MediaEngine{}
	if err := mediaEngine.RegisterDefaultCodecs(); err != nil {
		log.Fatalf("Gagal mendaftarkan default codecs: %v", err)
	}

	// Tambahkan Interceptor Registry untuk menangani NACK, PLI, & H264 dari Safari/Chrome
	interceptorRegistry := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(mediaEngine, interceptorRegistry); err != nil {
		log.Fatalf("Gagal mendaftarkan default interceptors: %v", err)
	}

	api := webrtc.NewAPI(
		webrtc.WithMediaEngine(mediaEngine),
		webrtc.WithInterceptorRegistry(interceptorRegistry),
	)

	return &WebRTCManager{
		streams:      make(map[string]*webrtc.TrackLocalStaticRTP),
		streamerPC:   make(map[string]*webrtc.PeerConnection),
		streamerSSRC: make(map[string]webrtc.SSRC),
		webrtcAPI:    api,
	}
}

// Config RTC dengan STUN server publik
func getRTCConfig() webrtc.Configuration {
	return webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{
			{
				URLs: []string{"stun:stun.l.google.com:19302"},
			},
		},
	}
}

// HandleIngest menangani koneksi dari Streamer
func (m *WebRTCManager) HandleIngest(streamID string, offer webrtc.SessionDescription, sendCandidate func(webrtc.ICECandidateInit)) (*webrtc.PeerConnection, *webrtc.SessionDescription, error) {
	pc, err := m.webrtcAPI.NewPeerConnection(getRTCConfig())
	if err != nil {
		return nil, nil, err
	}

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c != nil {
			sendCandidate(c.ToJSON())
		}
	})

	pc.OnTrack(func(remoteTrack *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		log.Printf("[Ingest] Track baru diterima: ID=%s, Codec=%s", remoteTrack.ID(), remoteTrack.Codec().MimeType)

		localTrack, err := webrtc.NewTrackLocalStaticRTP(
			remoteTrack.Codec().RTPCodecCapability,
			fmt.Sprintf("video_%s", streamID),
			"webrtc-sfu",
		)
		if err != nil {
			log.Printf("[Ingest] Gagal membuat local track: %v", err)
			return
		}

		m.mu.Lock()
		m.streams[streamID] = localTrack
		m.streamerPC[streamID] = pc
		m.streamerSSRC[streamID] = remoteTrack.SSRC()
		m.mu.Unlock()

		// Forward RTP packets
		go func() {
			buf := make([]byte, 1500)
			for {
				i, _, readErr := remoteTrack.Read(buf)
				if readErr != nil {
					if readErr != io.EOF {
						log.Printf("[Ingest] Error membaca RTP: %v", readErr)
					}
					break
				}

				if _, writeErr := localTrack.Write(buf[:i]); writeErr != nil {
					log.Printf("[Ingest] Error meneruskan RTP: %v", writeErr)
					break
				}
			}

			// Clean up saat streamer disconnect
			m.mu.Lock()
			delete(m.streams, streamID)
			delete(m.streamerPC, streamID)
			delete(m.streamerSSRC, streamID)
			m.mu.Unlock()
		}()
	})

	if err := pc.SetRemoteDescription(offer); err != nil {
		pc.Close()
		return nil, nil, err
	}

	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		pc.Close()
		return nil, nil, err
	}

	if err := pc.SetLocalDescription(answer); err != nil {
		pc.Close()
		return nil, nil, err
	}

	return pc, &answer, nil
}

// Inside HandleSubscribe function:
func (m *WebRTCManager) HandleSubscribe(streamID string, offer webrtc.SessionDescription, sendCandidate func(webrtc.ICECandidateInit)) (*webrtc.PeerConnection, *webrtc.SessionDescription, error) {
	var localTrack *webrtc.TrackLocalStaticRTP
	var streamerPC *webrtc.PeerConnection
	var streamerSSRC webrtc.SSRC
	var exists bool

	// Coba mengecek ketersediaan stream dengan retry singkat (maksimal 3 detik)
	for i := 0; i < 6; i++ {
		m.mu.RLock()
		localTrack, exists = m.streams[streamID]
		streamerPC = m.streamerPC[streamID]
		streamerSSRC = m.streamerSSRC[streamID]
		m.mu.RUnlock()

		if exists && localTrack != nil {
			break
		}
		time.Sleep(500 * time.Millisecond) // Tunggu 500ms sebelum cek ulang
	}

	if !exists || localTrack == nil {
		return nil, nil, fmt.Errorf("stream '%s' tidak ditemukan atau belum live", streamID)
	}

	if !exists || localTrack == nil {
		return nil, nil, fmt.Errorf("stream '%s' tidak ditemukan atau belum live", streamID)
	}

	pc, err := m.webrtcAPI.NewPeerConnection(getRTCConfig())
	if err != nil {
		return nil, nil, err
	}

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c != nil {
			sendCandidate(c.ToJSON())
		}
	})

	rtpSender, err := pc.AddTrack(localTrack)
	if err != nil {
		pc.Close()
		return nil, nil, err
	}

	// Baca RTCP dari Subscriber
	go func() {
		buf := make([]byte, 1500)
		for {
			if _, _, err := rtpSender.Read(buf); err != nil {
				return
			}
		}
	}()

	if err := pc.SetRemoteDescription(offer); err != nil {
		pc.Close()
		return nil, nil, err
	}

	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		pc.Close()
		return nil, nil, err
	}

	if err := pc.SetLocalDescription(answer); err != nil {
		pc.Close()
		return nil, nil, err
	}

	// Kirim paket PLI ke Streamer (Ingest) untuk meminta I-Frame/Keyframe baru
	if streamerPC != nil {
		go func() {
			_ = streamerPC.WriteRTCP([]rtcp.Packet{
				&rtcp.PictureLossIndication{MediaSSRC: uint32(streamerSSRC)},
			})
		}()
	}

	return pc, &answer, nil
}
