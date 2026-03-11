// public/client.js
let ws;
let localStream;
let peerConnection;
let clientId;
let currentRoomId;
let negotiating = false;

const config = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
    ],
};

// UI Elements
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const roomNameInput = document.getElementById('roomName');
const roomIdInput = document.getElementById('roomId');

// ============ WebSocket Setup ============
function connectWebSocket() {
    return new Promise((resolve) => {
        // Use relative URL to support local, port forwarding, and devtunnels automatically
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}`;
        // const wsUrl = `wss://1dh05vhj-3000.inc1.devtunnels.ms`;
        console.log('Connecting to WebSocket:', wsUrl);
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            console.log('WebSocket connected');
            resolve();
        };

        ws.onmessage = async (event) => {
            const message = JSON.parse(event.data);
            console.log('Received:', message.type); // Log type for cleaner console
            if (message.type === 'answer' || message.type === 'offer') {
                console.log('SDP Received:', message.jsep?.sdp?.substring(0, 100) + '...');
            }

            switch (message.type) {
                case 'connected':
                    clientId = message.clientId;
                    break;
                case 'joined':
                    console.log('Joined room as', message.role);
                    if (message.role === 'publisher') {
                        if (negotiating) return;
                        negotiating = true;
                        try {
                            const offer = await peerConnection.createOffer();
                            await peerConnection.setLocalDescription(offer);
                            ws.send(JSON.stringify({ type: 'publish', sdp: offer.sdp }));
                        } finally {
                            negotiating = false;
                        }
                    }
                    break;
                case 'answer':
                    if (message.jsep) {
                        try {
                            if (peerConnection.signalingState !== 'stable') {
                                await peerConnection.setRemoteDescription(new RTCSessionDescription(message.jsep));
                            }
                        } catch (e) {
                            console.error('Error setting remote answer:', e);
                        }
                    }
                    break;
                case 'offer':
                    if (message.jsep) {
                        await handleSubscriberOffer(message.jsep);
                    }
                    break;
                case 'trickle':
                    if (message.candidate && peerConnection) {
                        try {
                            // Only add if remote description is set
                            if (peerConnection.remoteDescription) {
                                await peerConnection.addIceCandidate(message.candidate);
                            }
                        } catch (e) {
                            console.error('Error adding remote candidate', e);
                        }
                    }
                    break;
                case 'webrtcup':
                    console.log('!!! WebRTC connection is UP !!!');
                    break;
                case 'hangup':
                    console.warn('!!! Janus sent HANGUP !!!');
                    break;
                case 'slowlink':
                    console.warn('Network Congestion detected!', message.data);
                    // notify('Slow connection detected');
                    break;
                case 'media':
                    console.log('Media state changed:', message.data.type, message.data.receiving ? 'Receiving' : 'Stopped');
                    break;
                case 'error':
                    alert('Server error: ' + message.error);
                    break;
            }
        };
    });
}

// ============ Creator/Streamer Flow ============
async function createRoom() {
    const name = roomNameInput.value || 'My Stream';
    try {
        const response = await fetch('/api/rooms', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
        });
        const data = await response.json();
        roomIdInput.value = data.room.id;
        console.log('Room created:', data.room);
        alert('Room Created! ID: ' + data.room.id);
    } catch (err) {
        console.error('Error creating room:', err);
    }
}

async function startPublishing() {
    const roomId = parseInt(roomIdInput.value);
    if (!roomId) return alert('Enter a Room ID');

    await connectWebSocket();

    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localVideo.srcObject = localStream;

        peerConnection = new RTCPeerConnection(config);
        negotiating = false; // Reset on new PC

        // Monitoring
        peerConnection.oniceconnectionstatechange = () => {
            console.log('ICE Connection State:', peerConnection.iceConnectionState);
            if (peerConnection.iceConnectionState === 'failed') {
                console.error('ICE Connection failed. This usually means Janus is behind a NAT/Docker and its candidates are unreachable.');
            }
        };
        peerConnection.onconnectionstatechange = () => {
            console.log('Overall Connection State:', peerConnection.connectionState);
        };

        localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

        peerConnection.onicecandidate = (event) => {
            ws.send(JSON.stringify({
                type: 'trickle',
                candidate: event.candidate ? event.candidate.toJSON() : { completed: true }
            }));
        };

        ws.send(JSON.stringify({
            type: 'join-as-publisher',
            roomId,
            displayName: 'Streamer'
        }));

        // We will receive 'joined' case in onmessage to continue with publish
    } catch (err) {
        console.error('Publisher error:', err);
    }
}

// ============ Watcher Flow ============
async function startWatching() {
    const roomId = parseInt(roomIdInput.value);
    if (!roomId) return alert('Enter a Room ID');

    await connectWebSocket();

    try {
        const response = await fetch(`/api/rooms/${roomId}`);
        const room = await response.json();

        if (!room.publishers || room.publishers.length === 0) {
            return alert('Nobody is streaming in this room yet.');
        }

        const feedId = room.publishers[0].janusId;
        console.log('Subscribing to feed:', feedId);

        peerConnection = new RTCPeerConnection(config);
        negotiating = false; // Reset on new PC

        peerConnection.oniceconnectionstatechange = () => {
            console.log('Watcher ICE Connection State:', peerConnection.iceConnectionState);
        };

        peerConnection.ontrack = (event) => {
            console.log('Received remote stream');
            remoteVideo.srcObject = event.streams[0];
        };

        peerConnection.onicecandidate = (event) => {
            ws.send(JSON.stringify({
                type: 'trickle',
                candidate: event.candidate ? event.candidate.toJSON() : { completed: true }
            }));
        };

        ws.send(JSON.stringify({ type: 'join-as-subscriber', roomId, feedId }));

    } catch (err) {
        console.error('Watcher error:', err);
    }
}

async function handleSubscriberOffer(jsep) {
    if (negotiating) {
        console.warn('Ignore offer, already negotiating...');
        return;
    }

    try {
        negotiating = true;
        await peerConnection.setRemoteDescription(new RTCSessionDescription(jsep));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        ws.send(JSON.stringify({ type: 'subscriber-answer', sdp: answer.sdp }));
    } catch (err) {
        console.error('Offer handle error:', err);
    } finally {
        negotiating = false;
    }
}