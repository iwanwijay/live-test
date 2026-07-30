// Interface untuk format pesan Signaling
interface WSMessage {
  type: "publish" | "subscribe" | "answer" | "candidate" | "error";
  stream_id?: string;
  sdp?: string;
  candidate?: RTCIceCandidateInit;
  message?: string;
}

// Konfigurasi WebSocket & WebRTC
const protocol: string = window.location.protocol === "https:" ? "wss:" : "ws:";
const wsUrl: string = `${protocol}//${window.location.host}/ws`;

const rtcConfig: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

// Fungsi pembantu untuk log di console
function logMsg(prefix: string, message: string, data?: any): void {
  if (data !== undefined) {
    console.log(`[${prefix}] ${message}`, data);
  } else {
    console.log(`[${prefix}] ${message}`);
  }
}

// Inisialisasi setelah DOM selesai dimuat
document.addEventListener("DOMContentLoaded", () => {
  logMsg("System", "App initialized. Connecting target WS: " + wsUrl);

  // Ambil elemen DOM
  const startPublishBtn = document.getElementById(
    "startPublishBtn",
  ) as HTMLButtonElement | null;
  const localVideo = document.getElementById(
    "localVideo",
  ) as HTMLVideoElement | null;
  const publishIdInput = document.getElementById(
    "publishIdInput",
  ) as HTMLInputElement | null;

  const startSubscribeBtn = document.getElementById(
    "startSubscribeBtn",
  ) as HTMLButtonElement | null;
  const remoteVideo = document.getElementById(
    "remoteVideo",
  ) as HTMLVideoElement | null;
  const subscribeIdInput = document.getElementById(
    "subscribeIdInput",
  ) as HTMLInputElement | null;

  // Verifikasi ketersediaan elemen
  if (!startPublishBtn)
    console.error("Elemen 'startPublishBtn' tidak ditemukan!");
  if (!localVideo) console.error("Elemen 'localVideo' tidak ditemukan!");
  if (!publishIdInput)
    console.error("Elemen 'publishIdInput' tidak ditemukan!");

  if (!startSubscribeBtn)
    console.error("Elemen 'startSubscribeBtn' tidak ditemukan!");
  if (!remoteVideo) console.error("Elemen 'remoteVideo' tidak ditemukan!");
  if (!subscribeIdInput)
    console.error("Elemen 'subscribeIdInput' tidak ditemukan!");

  // ==========================================
  // 1. STREAMER / PUBLISHER LOGIC
  // ==========================================
  if (startPublishBtn && localVideo && publishIdInput) {
    startPublishBtn.addEventListener("click", async (e: Event) => {
      e.preventDefault();
      logMsg("Publisher", "Tombol Start Live diklik.");

      const streamId: string = publishIdInput.value.trim();
      if (!streamId) {
        alert("Masukkan Stream ID terlebih dahulu!");
        return;
      }

      startPublishBtn.disabled = true;

      try {
        logMsg("Publisher", "Meminta izin kamera & mikrofon...");
        const stream: MediaStream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });

        logMsg("Publisher", "Akses kamera & mikrofon diizinkan.");
        localVideo.srcObject = stream;
        localVideo.muted = true; // Avoid feedback loop
        await localVideo
          .play()
          .catch((err) => logMsg("Publisher", "Video play warning:", err));

        const ws: WebSocket = new WebSocket(wsUrl);
        const pc: RTCPeerConnection = new RTCPeerConnection(rtcConfig);

        // Bind media track ke PeerConnection
        stream.getTracks().forEach((track: MediaStreamTrack) => {
          pc.addTrack(track, stream);
        });

        // Event ICE Candidate lokal
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

        ws.onopen = async (): Promise<void> => {
          logMsg("Publisher", "WebSocket terhubung. Membuat SDP Offer...");
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

        ws.onmessage = async (event: MessageEvent): Promise<void> => {
          const msg: WSMessage = JSON.parse(event.data);

          if (msg.type === "answer" && msg.sdp) {
            logMsg("Publisher", "SDP Answer diterima dari server.");
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
          console.error("[Publisher] WebSocket Error:", err);
          startPublishBtn.disabled = false;
        };

        ws.onclose = (): void => {
          logMsg("Publisher", "WebSocket terputus.");
        };
      } catch (err: any) {
        console.error("[Publisher] Error:", err);
        startPublishBtn.disabled = false;

        if (
          err.name === "NotAllowedError" ||
          err.name === "PermissionDeniedError"
        ) {
          alert(
            "Akses kamera/mikrofon ditolak. Mohon izinkan media di browser Anda.",
          );
        } else if (err.name === "NotFoundError") {
          alert("Kamera atau mikrofon tidak ditemukan.");
        } else {
          alert("Gagal mengambil media stream: " + err.message);
        }
      }
    });
  }

  // ==========================================
  // 2. PENONTON / SUBSCRIBER LOGIC
  // ==========================================
  if (startSubscribeBtn && remoteVideo && subscribeIdInput) {
    startSubscribeBtn.addEventListener("click", async (e: Event) => {
      e.preventDefault();
      logMsg("Subscriber", "Tombol Watch Live diklik.");

      const streamId: string = subscribeIdInput.value.trim();
      if (!streamId) {
        alert("Masukkan Stream ID terlebih dahulu!");
        return;
      }

      startSubscribeBtn.disabled = true;

      try {
        const ws: WebSocket = new WebSocket(wsUrl);
        const pc: RTCPeerConnection = new RTCPeerConnection(rtcConfig);

        // Siapkan transceiver receive-only
        pc.addTransceiver("video", { direction: "recvonly" });
        pc.addTransceiver("audio", { direction: "recvonly" });

        const remoteStream = new MediaStream();
        remoteVideo.srcObject = remoteStream;

        pc.ontrack = (event: RTCTrackEvent): void => {
          logMsg("Subscriber", "Track diterima:", event.track.kind);
          remoteStream.addTrack(event.track);

          remoteVideo.play().catch((err: Error) => {
            logMsg(
              "Subscriber",
              "Autoplay warning (perlu interaksi user):",
              err,
            );
          });
        };

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

        ws.onopen = async (): Promise<void> => {
          logMsg(
            "Subscriber",
            "WebSocket terhubung, meminta stream:",
            streamId,
          );
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

        ws.onmessage = async (event: MessageEvent): Promise<void> => {
          const msg: WSMessage = JSON.parse(event.data);

          if (msg.type === "answer" && msg.sdp) {
            logMsg("Subscriber", "SDP Answer diterima dari server.");
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
          console.error("[Subscriber] WebSocket Error:", err);
          startSubscribeBtn.disabled = false;
        };

        ws.onclose = (): void => {
          logMsg("Subscriber", "WebSocket terputus.");
        };
      } catch (err: any) {
        console.error("[Subscriber] Error:", err);
        startSubscribeBtn.disabled = false;
        alert("Gagal menonton stream: " + err.message);
      }
    });
  }
});
