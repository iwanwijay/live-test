package main

import (
	"log"
	"net/http"
)

func main() {
	rtcManager := NewWebRTCManager()
	signalingServer := NewSignalingServer(rtcManager)

	// Endpoint WebSocket Signaling
	http.HandleFunc("/ws", signalingServer.HandleWebSocket)

	// Serve Static Files (HTML & JS)
	fs := http.FileServer(http.Dir("./static"))
	http.Handle("/", fs)

	log.Println("🚀 Server berjalan di http://localhost:8085")
	if err := http.ListenAndServe(":8085", nil); err != nil {
		log.Fatalf("Gagal menjalankan server: %v", err)
	}
}
