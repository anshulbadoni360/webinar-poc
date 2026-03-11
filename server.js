const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const JanusService = require('./services/janusServices.js');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const janus = new JanusService('wss://prodrtc.monetanalytics.com/rtc-scale/');
// const janus = new JanusService('ws://localhost:8188');

// Store rooms and their publishers
const rooms = new Map(); // roomId -> { id, name, publishers: [] }
const clients = new Map(); // clientId -> { ws, sessionId, handleId, janusId, roomId, heartbeat }

// Connect to Janus
janus.connect().then(() => {
    console.log('Connected to Janus');
}).catch(err => {
    console.error('Failed to connect to Janus:', err);
});

// Route Janus events back to clients
janus.onEvent = (message) => {
    const { session_id, janus: eventType, sender } = message;

    // Find client by session_id
    for (const [clientId, client] of clients.entries()) {
        if (client.sessionId === session_id) {
            // Forward relevant events
            if (eventType === 'trickle') {
                client.ws.send(JSON.stringify({
                    type: 'trickle',
                    candidate: message.candidate,
                    feedId: message.feedId // For subscribers
                }));
            } else if (eventType === 'webrtcup') {
                client.ws.send(JSON.stringify({ type: 'webrtcup' }));
            } else if (eventType === 'hangup') {
                client.ws.send(JSON.stringify({ type: 'hangup' }));
            } else if (eventType === 'slowlink') {
                client.ws.send(JSON.stringify({ type: 'slowlink', data: message }));
            } else if (eventType === 'media') {
                client.ws.send(JSON.stringify({ type: 'media', data: message }));
            } else if (eventType === 'event' && message.plugindata && message.jsep) {
                // This could be an offer for a subscriber
                client.ws.send(JSON.stringify({
                    type: 'offer',
                    jsep: message.jsep,
                    feedId: message.feedId
                }));
            }
            break;
        }
    }
};

// --- API Routes ---

app.post('/api/rooms', (req, res) => {
    const { name, description } = req.body;
    const roomId = Math.floor(Math.random() * 1000000);
    const room = { id: roomId, name, description, publishers: [] };
    rooms.set(roomId, room);
    res.json({ room });
});

app.get('/api/rooms/:id', (req, res) => {
    const room = rooms.get(parseInt(req.params.id));
    if (!room) return res.status(404).json({ error: 'Room not found' });
    res.json(room);
});

// --- WebSocket Signaling ---

wss.on('connection', (ws) => {
    const clientId = uuidv4();
    const clientState = { ws, isAlive: true };
    clients.set(clientId, clientState);
    console.log(`Client connected: ${clientId}`);

    // WebSocket heartbeat to prevent tunnel timeout
    ws.on('pong', () => { clientState.isAlive = true; });

    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data);
            await handleSignaling(clientId, message, ws);
        } catch (err) {
            console.error('Signaling error:', err);
            ws.send(JSON.stringify({ type: 'error', error: err.message }));
        }
    });

    ws.on('close', async (code, reason) => {
        const client = clients.get(clientId);
        console.log(`[WebSocket Close] Client: ${clientId}, Code: ${code}, Reason: ${reason || 'none'}`);

        if (client) {
            if (client.heartbeat) clearInterval(client.heartbeat);
            if (client.sessionId) {
                try {
                    console.log(`Cleaning up Janus session ${client.sessionId} for client ${clientId}`);
                    await janus.destroySession(client.sessionId);
                } catch (e) {
                    console.warn(`Failed to destroy session ${client.sessionId}: ${e.message}`);
                }
            }
            // Remove from room publishers if streamer
            if (client.roomId && client.janusId) {
                const room = rooms.get(client.roomId);
                if (room) {
                    room.publishers = room.publishers.filter(p => p.janusId !== client.janusId);
                }
            }
        }
        clients.delete(clientId);
    });

    ws.send(JSON.stringify({ type: 'connected', clientId }));
});

// Ping interval
const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        const clientEntry = [...clients.values()].find(c => c.ws === ws);
        if (clientEntry) {
            if (clientEntry.isAlive === false) {
                console.warn(`Client ${[...clients.keys()].find(k => clients.get(k) === clientEntry)} timed out, terminating...`);
                return ws.terminate();
            }
            clientEntry.isAlive = false;
            ws.ping();
        }
    });
}, 30000);

wss.on('close', () => {
    clearInterval(pingInterval);
});

function startHeartbeat(clientId) {
    const client = clients.get(clientId);
    if (!client || !client.sessionId) return;

    client.heartbeat = setInterval(async () => {
        try {
            await janus.keepAlive(client.sessionId);
        } catch (error) {
            console.error(`Keep-alive failed for client ${clientId}, dropping session:`, error.message);
            clearInterval(client.heartbeat);
            client.heartbeat = null;
        }
    }, 20000); // Shortened to 20s for safety
}

async function handleSignaling(clientId, message, ws) {
    const client = clients.get(clientId);

    switch (message.type) {
        case 'join-as-publisher': {
            const { roomId, displayName } = message;
            const sessionId = await janus.createSession();
            const handleId = await janus.attachPlugin(sessionId, 'janus.plugin.videoroom');

            client.sessionId = sessionId;
            client.handleId = handleId;
            client.roomId = parseInt(roomId);

            // 1. Explicitly create room in Janus
            try {
                console.log(`Creating room ${client.roomId} in Janus...`);
                await janus.createVideoRoom(sessionId, handleId, client.roomId, `Room ${client.roomId}`);
            } catch (err) {
                // Ignore "room already exists" (error 427)
                if (!err.message.includes('427')) {
                    throw err;
                }
                console.log(`Room ${client.roomId} already exists in Janus.`);
            }

            // 2. Track room locally
            if (!rooms.has(client.roomId)) {
                rooms.set(client.roomId, { id: client.roomId, name: 'Auto-room', publishers: [] });
            }

            // 3. Join room as publisher
            const response = await janus.joinAsPublisher(sessionId, handleId, client.roomId, displayName);

            if (response.plugindata && response.plugindata.data && response.plugindata.data.id) {
                client.janusId = response.plugindata.data.id;
                const room = rooms.get(client.roomId);
                if (room) {
                    room.publishers.push({ janusId: client.janusId, displayName });
                }
            }

            ws.send(JSON.stringify({ type: 'joined', role: 'publisher', data: response }));
            startHeartbeat(clientId);
            break;
        }

        case 'publish': {
            const { sdp } = message;
            console.log(`Client ${clientId} is publishing SDP...`);
            const response = await janus.publish(client.sessionId, client.handleId, sdp);

            if (!response.jsep) {
                console.warn('Janus returned no JSEP for publish:', JSON.stringify(response));
            }

            ws.send(JSON.stringify({
                type: 'answer',
                jsep: response.jsep || null,
                janusResponse: response // Pass through for debugging
            }));
            break;
        }

        case 'join-as-subscriber': {
            const { roomId, feedId } = message;
            const sessionId = await janus.createSession();
            const handleId = await janus.attachPlugin(sessionId, 'janus.plugin.videoroom');

            client.sessionId = sessionId;
            client.handleId = handleId;
            client.roomId = parseInt(roomId);

            const response = await janus.joinAsSubscriber(sessionId, handleId, client.roomId, feedId);

            // JSEP for subscriber is usually in the join response
            ws.send(JSON.stringify({
                type: 'offer',
                jsep: response.jsep || null,
                feedId: feedId
            }));

            startHeartbeat(clientId);
            break;
        }

        case 'subscriber-answer': {
            const { sdp } = message;
            await janus.sendPluginMessage(client.sessionId, client.handleId, { request: 'start', room: client.roomId }, { type: 'answer', sdp });
            break;
        }

        case 'trickle': {
            const { candidate } = message;
            // console.log(`Routing candidate for ${clientId}`);
            await janus.trickle(client.sessionId, client.handleId, candidate);
            break;
        }
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
