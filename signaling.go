package main

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// Format Pesan WebSocket
type WSMessage struct {
	Type      string                   `json:"type"`      // "publish", "subscribe", "answer", "candidate", "error"
	StreamID  string                   `json:"stream_id"` // ID stream
	SDP       string                   `json:"sdp,omitempty"`
	Candidate *webrtc.ICECandidateInit `json:"candidate,omitempty"`
	Message   string                   `json:"message,omitempty"`
}

type SignalingServer struct {
	rtcManager *WebRTCManager
}

func NewSignalingServer(rtcManager *WebRTCManager) *SignalingServer {
	return &SignalingServer{rtcManager: rtcManager}
}

func (s *SignalingServer) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("Gagal upgrade WebSocket: %v", err)
		return
	}
	defer conn.Close()

	var mu sync.Mutex
	writeJSON := func(v interface{}) {
		mu.Lock()
		defer mu.Unlock()
		conn.WriteJSON(v)
	}

	var pc *webrtc.PeerConnection
	var candidateBuffer []webrtc.ICECandidateInit

	for {
		_, msgBytes, err := conn.ReadMessage()
		if err != nil {
			break
		}

		var msg WSMessage
		if err := json.Unmarshal(msgBytes, &msg); err != nil {
			log.Printf("Format JSON tidak valid: %v", err)
			continue
		}

		switch msg.Type {
		case "publish":
			log.Printf("Client mencoba Publish stream: %s", msg.StreamID)
			offer := webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: msg.SDP}

			sendCandidateFunc := func(c webrtc.ICECandidateInit) {
				writeJSON(WSMessage{Type: "candidate", Candidate: &c})
			}

			peerConn, answer, err := s.rtcManager.HandleIngest(msg.StreamID, offer, sendCandidateFunc)
			if err != nil {
				writeJSON(WSMessage{Type: "error", Message: err.Error()})
				return
			}
			pc = peerConn

			// Flush buffered candidates jika ada
			for _, cand := range candidateBuffer {
				pc.AddICECandidate(cand)
			}
			candidateBuffer = nil

			writeJSON(WSMessage{Type: "answer", SDP: answer.SDP})

		case "subscribe":
			log.Printf("Client mencoba Subscribe stream: %s", msg.StreamID)
			offer := webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: msg.SDP}

			sendCandidateFunc := func(c webrtc.ICECandidateInit) {
				writeJSON(WSMessage{Type: "candidate", Candidate: &c})
			}

			peerConn, answer, err := s.rtcManager.HandleSubscribe(msg.StreamID, offer, sendCandidateFunc)
			if err != nil {
				writeJSON(WSMessage{Type: "error", Message: err.Error()})
				return
			}
			pc = peerConn

			for _, cand := range candidateBuffer {
				pc.AddICECandidate(cand)
			}
			candidateBuffer = nil

			writeJSON(WSMessage{Type: "answer", SDP: answer.SDP})

		case "candidate":
			if msg.Candidate != nil {
				if pc != nil && pc.RemoteDescription() != nil {
					pc.AddICECandidate(*msg.Candidate)
				} else {
					candidateBuffer = append(candidateBuffer, *msg.Candidate)
				}
			}
		}
	}

	if pc != nil {
		pc.Close()
	}
}
