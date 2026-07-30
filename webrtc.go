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
	streams      map[string][]*webrtc.TrackLocalStaticRTP // Mendukung multiple tracks (Video + Audio)
	streamerPC   map[string]*webrtc.PeerConnection        // PC Streamer untuk request PLI
	streamerSSRC map[string]webrtc.SSRC                   // SSRC Video Streamer
	webrtcAPI    *webrtc.API
}

func NewWebRTCManager() *WebRTCManager {
	mediaEngine := &webrtc.MediaEngine{}

	// Register default codecs (VP8, VP9, H264, Opus, PCMU, PCMA)
	if err := mediaEngine.RegisterDefaultCodecs(); err != nil {
		log.Fatalf("Gagal mendaftarkan default codecs: %v", err)
	}

	// Register Interceptor untuk menangani NACK, PLI, & Bandwidth Estimator
	interceptorRegistry := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(mediaEngine, interceptorRegistry); err != nil {
		log.Fatalf("Gagal mendaftarkan default interceptors: %v", err)
	}

	api := webrtc.NewAPI(
		webrtc.WithMediaEngine(mediaEngine),
		webrtc.WithInterceptorRegistry(interceptorRegistry),
	)

	return &WebRTCManager{
		streams:      make(map[string][]*webrtc.TrackLocalStaticRTP),
		streamerPC:   make(map[string]*webrtc.PeerConnection),
		streamerSSRC: make(map[string]webrtc.SSRC),
		webrtcAPI:    api,
	}
}

func getRTCConfig() webrtc.Configuration {
	return webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{
			{
				URLs: []string{"stun:stun.l.google.com:19302"},
			},
		},
	}
}

// HandleIngest menangani koneksi dari Streamer (Publisher)
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
		log.Printf("[Ingest] Track baru diterima untuk stream '%s': Kind=%s, Codec=%s",
			streamID, remoteTrack.Kind().String(), remoteTrack.Codec().MimeType)

		// Buat Local Track untuk di-broadcast ke subscribers
		localTrack, err := webrtc.NewTrackLocalStaticRTP(
			remoteTrack.Codec().RTPCodecCapability,
			remoteTrack.ID(),
			fmt.Sprintf("webrtc-sfu-%s", streamID),
		)
		if err != nil {
			log.Printf("[Ingest] Gagal membuat local track (%s): %v", remoteTrack.Kind().String(), err)
			return
		}

		m.mu.Lock()
		m.streams[streamID] = append(m.streams[streamID], localTrack)
		m.streamerPC[streamID] = pc
		if remoteTrack.Kind() == webrtc.RTPCodecTypeVideo {
			m.streamerSSRC[streamID] = remoteTrack.SSRC()
		}
		m.mu.Unlock()

		// Forward RTP Packets dari Streamer ke Local Track
		go func() {
			buf := make([]byte, 1500)
			for {
				i, _, readErr := remoteTrack.Read(buf)
				if readErr != nil {
					if readErr != io.EOF {
						log.Printf("[Ingest] Error membaca RTP (%s): %v", remoteTrack.Kind().String(), readErr)
					}
					break
				}

				if _, writeErr := localTrack.Write(buf[:i]); writeErr != nil {
					log.Printf("[Ingest] Error meneruskan RTP (%s): %v", remoteTrack.Kind().String(), writeErr)
					break
				}
			}

			// Cleanup saat streamer disconnect
			m.mu.Lock()
			delete(m.streams, streamID)
			delete(m.streamerPC, streamID)
			delete(m.streamerSSRC, streamID)
			m.mu.Unlock()
			log.Printf("[Ingest] Stream '%s' dibersihkan.", streamID)
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

// HandleSubscribe menangani koneksi dari Penonton (Subscriber)
func (m *WebRTCManager) HandleSubscribe(streamID string, offer webrtc.SessionDescription, sendCandidate func(webrtc.ICECandidateInit)) (*webrtc.PeerConnection, *webrtc.SessionDescription, error) {
	var tracks []*webrtc.TrackLocalStaticRTP
	var streamerPC *webrtc.PeerConnection
	var streamerSSRC webrtc.SSRC
	var exists bool

	// Retry loop (maksimal 3 detik) untuk mengantisipasi race-condition saat subscriber join
	for i := 0; i < 6; i++ {
		m.mu.RLock()
		tracks, exists = m.streams[streamID]
		streamerPC = m.streamerPC[streamID]
		streamerSSRC = m.streamerSSRC[streamID]
		m.mu.RUnlock()

		if exists && len(tracks) > 0 {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}

	if !exists || len(tracks) == 0 {
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

	// Inject seluruh tracks (Video + Audio) ke PeerConnection Subscriber
	for _, track := range tracks {
		rtpSender, err := pc.AddTrack(track)
		if err != nil {
			log.Printf("[Subscribe] Gagal menambahkan track ke subscriber: %v", err)
			continue
		}

		// Membaca RTCP feedback dari Subscriber
		go func(sender *webrtc.RTPSender) {
			buf := make([]byte, 1500)
			for {
				if _, _, err := sender.Read(buf); err != nil {
					return
				}
			}
		}(rtpSender)
	}

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

	// Request Keyframe (PLI) ke Streamer agar video penonton langsung muncul
	if streamerPC != nil && streamerSSRC != 0 {
		go func() {
			_ = streamerPC.WriteRTCP([]rtcp.Packet{
				&rtcp.PictureLossIndication{MediaSSRC: uint32(streamerSSRC)},
			})
		}()
	}

	return pc, &answer, nil
}
