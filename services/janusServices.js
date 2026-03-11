// services/janusService.js
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

class JanusService {
    constructor(janusUrl) {
        this.janusUrl = janusUrl; // ws://localhost:8188
        this.sessions = new Map();
        this.transactions = new Map();
    }

    connect() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.janusUrl, 'janus-protocol');

            this.ws.on('open', () => {
                console.log('Connected to Janus');
                resolve();
            });

            this.ws.on('message', (data) => {
                const message = JSON.parse(data);
                this.handleMessage(message);
            });

            this.ws.on('error', (err) => reject(err));
        });
    }

    handleMessage(message) {
        const { transaction, janus, session_id, sender } = message;

        // Transactional response
        if (transaction && this.transactions.has(transaction)) {
            const { resolve, type } = this.transactions.get(transaction);
            
            if (janus === 'ack') {
                // For trickle and keepalive, 'ack' is the final response.
                // For others (publish, join), we must wait for the actual event/success.
                if (type === 'trickle' || type === 'keepalive') {
                    this.transactions.delete(transaction);
                    resolve(message);
                }
                return;
            }
            
            this.transactions.delete(transaction);
            resolve(message);
            return;
        }

        // Asynchronous Janus event/trickle/status
        if (this.onEvent) {
            this.onEvent(message);
        }
    }

    sendMessage(message) {
        return new Promise((resolve, reject) => {
            const transaction = uuidv4();
            message.transaction = transaction;

            this.transactions.set(transaction, { 
                resolve, 
                reject, 
                type: message.janus // Store type to handle ACK correctly
            });
            this.ws.send(JSON.stringify(message));

            // Timeout after 15 seconds
            setTimeout(() => {
                if (this.transactions.has(transaction)) {
                    this.transactions.delete(transaction);
                    reject(new Error(`Janus request timeout (${message.janus})`));
                }
            }, 15000);
        });
    }

    // Step 1: Create a Janus session
    async createSession() {
        const response = await this.sendMessage({
            janus: 'create',
        });
        if (response.janus === 'error') {
            throw new Error(`Janus create session error: ${JSON.stringify(response.error)}`);
        }
        return response.data.id;
    }

    // Step 2: Attach to a plugin (e.g., videoroom or streaming)
    async attachPlugin(sessionId, plugin) {
        const response = await this.sendMessage({
            janus: 'attach',
            session_id: sessionId,
            plugin: plugin,
        });
        if (response.janus === 'error') {
            throw new Error(`Janus attach plugin error: ${JSON.stringify(response.error)}`);
        }
        return response.data.id; // handle_id
    }

    // Step 3: Send plugin message
    async sendPluginMessage(sessionId, handleId, body, jsep = null) {
        const message = {
            janus: 'message',
            session_id: sessionId,
            handle_id: handleId,
            body: body,
        };
        if (jsep) message.jsep = jsep;
        const response = await this.sendMessage(message);
        
        if (response.janus === 'error') {
            throw new Error(`Janus protocol error: ${JSON.stringify(response.error)}`);
        }
        
        // Check for plugin-level errors
        if (response.plugindata && response.plugindata.data && response.plugindata.data.error) {
            throw new Error(`Janus plugin error (${response.plugindata.data.error_code}): ${response.plugindata.data.error}`);
        }
        
        return response;
    }

    // Create a video room
    async createVideoRoom(sessionId, handleId, roomId, description) {
        return await this.sendPluginMessage(sessionId, handleId, {
            request: 'create',
            room: roomId,
            description: description,
            publishers: 6,
            bitrate: 512000,
            record: false,
            videocodec: 'vp8,h264',
            audiocodec: 'opus',
        });
    }

    // Join a room as publisher
    async joinAsPublisher(sessionId, handleId, roomId, displayName) {
        return await this.sendPluginMessage(sessionId, handleId, {
            request: 'join',
            room: roomId,
            ptype: 'publisher',
            display: displayName,
        });
    }

    // Join a room as subscriber
    async joinAsSubscriber(sessionId, handleId, roomId, feedId) {
        return await this.sendPluginMessage(sessionId, handleId, {
            request: 'join',
            room: roomId,
            ptype: 'subscriber',
            feed: feedId,
        });
    }

    // Publish stream (send SDP offer)
    async publish(sessionId, handleId, sdpOffer) {
        return await this.sendPluginMessage(
            sessionId,
            handleId,
            { request: 'configure', audio: true, video: true },
            { type: 'offer', sdp: sdpOffer }
        );
    }

    // Keep-alive
    async keepAlive(sessionId) {
        return await this.sendMessage({
            janus: 'keepalive',
            session_id: sessionId,
        });
    }

    // Trickle ICE candidate
    async trickle(sessionId, handleId, candidate) {
        return await this.sendMessage({
            janus: 'trickle',
            session_id: sessionId,
            handle_id: handleId,
            candidate: candidate,
        });
    }

    // Destroy session
    async destroySession(sessionId) {
        return await this.sendMessage({
            janus: 'destroy',
            session_id: sessionId,
        });
    }
}

module.exports = JanusService;