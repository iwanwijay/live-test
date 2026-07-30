// Interface untuk pesan Signaling WebSocket
interface WSMessage {
  type: "publish" | "subscribe" | "answer" | "candidate" | "error";
  stream_id?: string;
  sdp?: string;
  candidate?: RTCIceCandidateInit;
  message?: string;
}

// Gunakan protokol secure (wss://) jika diakses via HTTPS, atau (ws://) jika di local HTTP
const protocol: string = window.location.protocol === "https:" ? "wss:" : "ws:";
const wsUrl: string = `${protocol}//${window.location.host}/ws`;

// Configuration WebRTC (STUN Server)
const rtcConfig: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

// ==========================================
// 1. PUBLISHER / STREAMER LOGIC
// ==========================================
const startPublishBtn = document.getElementById(
  "startPublishBtn",
) as HTMLButtonElement | null;
const localVideo = document.getElementById(
  "localVideo",
) as HTMLVideoElement | null;
const publishIdInput = document.getElementById(
  "publishIdInput",
) as HTMLInputElement | null;

if (startPublishBtn && localVideo && publishIdInput) {
  startPublishBtn.onclick = async (): Promise<void> => {
    const streamId: string = publishIdInput.value.trim();
    if (!streamId) return alert("Masukkan Stream ID terlebih dahulu!");

    startPublishBtn.disabled = true;

    try {
      // 1. Ambil Stream Kamera + Mikrofon dari user
      const stream: MediaStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });

      // Tampilkan stream lokal di elemen video dan MUTE agar streamer tidak mengalami echo
      localVideo.srcObject = stream;
      localVideo.muted = true;
      await localVideo
        .play()
        .catch((err) => console.warn("Local video play warning:", err));

      // 2. Inisialisasi WebSocket & RTCPeerConnection
      const ws: WebSocket = new WebSocket(wsUrl);
      const pc: RTCPeerConnection = new RTCPeerConnection(rtcConfig);

      // Tambahkan seluruh track (Video + Audio) ke PeerConnection
      stream.getTracks().forEach((track: MediaStreamTrack) => {
        pc.addTrack(track, stream);
      });

      // Handle ICE Candidate dari lokal untuk dikirim ke server Go
      pc.onicecandidate = (event: RTCPeerConnectionIceEvent): void => {
        if (event.candidate && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "candidate",
              candidate: event.candidate.toJSON(),
            } as WSMessage),
          );
        }
      };

      // 3. Buat Offer SDP saat WebSocket terbuka
      ws.onopen = async (): Promise<void> => {
        console.log("[Publisher] WS connected, sending publish SDP offer...");
        const offer: RTCSessionDescriptionInit = await pc.createOffer();
        await pc.setLocalDescription(offer);

        ws.send(
          JSON.stringify({
            type: "publish",
            stream_id: streamId,
            sdp: offer.sdp,
          } as WSMessage),
        );
      };

      // 4. Handle pesan balasan dari Server Go
      ws.onmessage = async (event: MessageEvent): Promise<void> => {
        const msg: WSMessage = JSON.parse(event.data);

        if (msg.type === "answer" && msg.sdp) {
          console.log("[Publisher] SDP Answer diterima dari server.");
          await pc.setRemoteDescription(
            new RTCSessionDescription({ type: "answer", sdp: msg.sdp }),
          );
        } else if (msg.type === "candidate" && msg.candidate) {
          await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        } else if (msg.type === "error") {
          alert("Publish Error: " + msg.message);
          startPublishBtn.disabled = false;
        }
      };

      ws.onerror = (err: Event): void => {
        console.error("[Publisher] WS Error:", err);
        startPublishBtn.disabled = false;
      };

      ws.onclose = (): void => {
        console.log("[Publisher] WS Connection closed.");
      };
    } catch (err: any) {
      console.error("Failed to publish stream:", err);
      startPublishBtn.disabled = false;

      if (
        err.name === "NotAllowedError" ||
        err.name === "PermissionDeniedError"
      ) {
        alert(
          "Akses kamera/mikrofon ditolak. Izinkan akses media pada browser Anda.",
        );
      } else if (err.name === "NotFoundError") {
        alert("Perangkat kamera atau mikrofon tidak ditemukan.");
      } else {
        alert("Gagal mengambil media stream: " + err.message);
      }
    }
  };
}

// ==========================================
// 2. SUBSCRIBER / PENONTON LOGIC
// ==========================================
const startSubscribeBtn = document.getElementById(
  "startSubscribeBtn",
) as HTMLButtonElement | null;
const remoteVideo = document.getElementById(
  "remoteVideo",
) as HTMLVideoElement | null;
const subscribeIdInput = document.getElementById(
  "subscribeIdInput",
) as HTMLInputElement | null;

if (startSubscribeBtn && remoteVideo && subscribeIdInput) {
  startSubscribeBtn.onclick = async (): Promise<void> => {
    const streamId: string = subscribeIdInput.value.trim();
    if (!streamId) return alert("Masukkan Stream ID terlebih dahulu!");

    startSubscribeBtn.disabled = true;

    try {
      const ws: WebSocket = new WebSocket(wsUrl);
      const pc: RTCPeerConnection = new RTCPeerConnection(rtcConfig);

      // Siapkan transceiver receive-only untuk Video dan Audio
      pc.addTransceiver("video", { direction: "recvonly" });
      pc.addTransceiver("audio", { direction: "recvonly" });

      // Inisialisasi MediaStream penampung untuk dimasukkan ke remoteVideo
      const remoteStream = new MediaStream();
      remoteVideo.srcObject = remoteStream;

      // Terima track (Video / Audio) yang dikirim oleh SFU Server Go
      pc.ontrack = (event: RTCTrackEvent): void => {
        console.log("[Subscriber] Track diterima:", event.track.kind);
        remoteStream.addTrack(event.track);

        // Paksa panggil play ketika track ditambahkan
        remoteVideo.play().catch((err: Error) => {
          console.warn(
            "[Subscriber] Autoplay diblokir/perlu interaksi user:",
            err,
          );
        });
      };

      // Handle ICE Candidate
      pc.onicecandidate = (event: RTCPeerConnectionIceEvent): void => {
        if (event.candidate && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "candidate",
              candidate: event.candidate.toJSON(),
            } as WSMessage),
          );
        }
      };

      // Buat Offer SDP untuk Subscribe saat WS terbuka
      ws.onopen = async (): Promise<void> => {
        console.log("[Subscriber] WS connected, requesting stream:", streamId);
        const offer: RTCSessionDescriptionInit = await pc.createOffer();
        await pc.setLocalDescription(offer);

        ws.send(
          JSON.stringify({
            type: "subscribe",
            stream_id: streamId,
            sdp: offer.sdp,
          } as WSMessage),
        );
      };

      // Handle pesan Answer dari Server Go
      ws.onmessage = async (event: MessageEvent): Promise<void> => {
        const msg: WSMessage = JSON.parse(event.data);

        if (msg.type === "answer" && msg.sdp) {
          console.log("[Subscriber] SDP Answer diterima dari server.");
          await pc.setRemoteDescription(
            new RTCSessionDescription({ type: "answer", sdp: msg.sdp }),
          );
        } else if (msg.type === "candidate" && msg.candidate) {
          await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        } else if (msg.type === "error") {
          alert("Subscribe Error: " + msg.message);
          startSubscribeBtn.disabled = false;
        }
      };

      ws.onerror = (err: Event): void => {
        console.error("[Subscriber] WS Error:", err);
        startSubscribeBtn.disabled = false;
      };

      ws.onclose = (): void => {
        console.log("[Subscriber] WS Connection closed.");
      };
    } catch (err: any) {
      console.error("Failed to subscribe:", err);
      startSubscribeBtn.disabled = false;
      alert("Gagal menonton stream: " + err.message);
    }
  };
}
