// Interface untuk format pesan WebSocket
interface WSMessage {
  type: "publish" | "subscribe" | "answer" | "candidate" | "error";
  stream_id?: string;
  sdp?: string;
  candidate?: RTCIceCandidateInit;
  message?: string;
}

const wsUrl: string = `ws://${window.location.host}/ws`;

// --- PUBLISHER LOGIC ---
const startPublishBtn = document.getElementById(
  "startPublishBtn",
) as HTMLButtonElement | null;
const localVideo = document.getElementById(
  "localVideo",
) as HTMLVideoElement | null;
const streamIdInput = document.getElementById(
  "streamIdInput",
) as HTMLInputElement | null;

if (startPublishBtn && localVideo && streamIdInput) {
  startPublishBtn.onclick = async (): Promise<void> => {
    const streamId: string = streamIdInput.value;
    if (!streamId) return alert("Masukkan Stream ID");

    startPublishBtn.disabled = true;

    try {
      // 1. Ambil Media Lokal (Kamera & Mikrofon)
      const stream: MediaStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      localVideo.srcObject = stream;

      // 2. Buka WebSocket & PeerConnection
      const ws: WebSocket = new WebSocket(wsUrl);
      const pc: RTCPeerConnection = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });

      // Tambahkan Track ke PeerConnection
      stream.getTracks().forEach((track: MediaStreamTrack) => {
        pc.addTrack(track, stream);
      });

      // Kirim Candidate ke Server
      pc.onicecandidate = (e: RTCPeerConnectionIceEvent): void => {
        if (e.candidate) {
          const payload: WSMessage = {
            type: "candidate",
            candidate: e.candidate.toJSON(),
          };
          ws.send(JSON.stringify(payload));
        }
      };

      ws.onopen = async (): Promise<void> => {
        const offer: RTCSessionDescriptionInit = await pc.createOffer();
        await pc.setLocalDescription(offer);

        const payload: WSMessage = {
          type: "publish",
          stream_id: streamId,
          sdp: offer.sdp,
        };
        ws.send(JSON.stringify(payload));
      };

      ws.onmessage = async (event: MessageEvent): Promise<void> => {
        const msg: WSMessage = JSON.parse(event.data);
        if (msg.type === "answer" && msg.sdp) {
          await pc.setRemoteDescription(
            new RTCSessionDescription({ type: "answer", sdp: msg.sdp }),
          );
        } else if (msg.type === "candidate" && msg.candidate) {
          await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        } else if (msg.type === "error") {
          alert("Error: " + msg.message);
          startPublishBtn.disabled = false;
        }
      };
    } catch (err) {
      console.error("Failed to publish stream:", err);
      startPublishBtn.disabled = false;
    }
  };
}

// --- SUBSCRIBER LOGIC ---
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
    const streamId: string = subscribeIdInput.value;
    if (!streamId) return alert("Masukkan Stream ID");

    startSubscribeBtn.disabled = true;

    try {
      const ws: WebSocket = new WebSocket(wsUrl);
      const pc: RTCPeerConnection = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });

      // Tangkap Remote Track dari Server
      pc.ontrack = (event: RTCTrackEvent): void => {
        console.log("Track diterima oleh subscriber:", event.track.kind);

        if (remoteVideo) {
          // 1. Jika remoteVideo belum punya srcObject, pasang stream baru
          if (!remoteVideo.srcObject) {
            if (event.streams && event.streams[0]) {
              remoteVideo.srcObject = event.streams[0];
            } else {
              const inboundStream = new MediaStream();
              inboundStream.addTrack(event.track);
              remoteVideo.srcObject = inboundStream;
            }

            // Putar video
            remoteVideo.play().catch((err) => {
              console.warn("Autoplay diblokir atau di-interrupt:", err);
            });
          } else {
            // 2. Jika sudah ada srcObject (misal audio/video track susulan),
            // tambahkan track baru ke MediaStream yang sudah berjalan
            const currentStream = remoteVideo.srcObject as MediaStream;
            currentStream.addTrack(event.track);
          }
        }
      };

      pc.onicecandidate = (e: RTCPeerConnectionIceEvent): void => {
        if (e.candidate) {
          const payload: WSMessage = {
            type: "candidate",
            candidate: e.candidate.toJSON(),
          };
          ws.send(JSON.stringify(payload));
        }
      };

      ws.onopen = async (): Promise<void> => {
        pc.addTransceiver("video", { direction: "recvonly" });
        pc.addTransceiver("audio", { direction: "recvonly" });

        const offer: RTCSessionDescriptionInit = await pc.createOffer();
        await pc.setLocalDescription(offer);

        const payload: WSMessage = {
          type: "subscribe",
          stream_id: streamId,
          sdp: offer.sdp,
        };
        ws.send(JSON.stringify(payload));
      };

      ws.onmessage = async (event: MessageEvent): Promise<void> => {
        const msg: WSMessage = JSON.parse(event.data);
        if (msg.type === "answer" && msg.sdp) {
          await pc.setRemoteDescription(
            new RTCSessionDescription({ type: "answer", sdp: msg.sdp }),
          );
        } else if (msg.type === "candidate" && msg.candidate) {
          await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
        } else if (msg.type === "error") {
          alert("Error: " + msg.message);
          startSubscribeBtn.disabled = false;
        }
      };
    } catch (err) {
      console.error("Failed to subscribe stream:", err);
      startSubscribeBtn.disabled = false;
    }
  };
}
