// WebSocket client for file uploads and downloads
class WebSocketClient {
  constructor() {
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 1000;
    this.messageHandlers = new Map();
    this.connectionPromise = null;
  }

  /**
   * Connect to WebSocket server
   */
  connect() {
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = new Promise((resolve, reject) => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}`;
      
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('WebSocket connected');
        this.reconnectAttempts = 0;
        resolve(this.ws);
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          this.handleMessage(message);
        } catch (err) {
          console.error('Error parsing WebSocket message:', err);
        }
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        reject(error);
      };

      this.ws.onclose = () => {
        console.log('WebSocket disconnected');
        this.connectionPromise = null;
        this.attemptReconnect();
      };
    });

    return this.connectionPromise;
  }

  /**
   * Attempt to reconnect
   */
  attemptReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      setTimeout(() => {
        console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
        this.connect();
      }, this.reconnectDelay * this.reconnectAttempts);
    }
  }

  /**
   * Send message to server
   */
  send(type, payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return this.connect().then(() => {
        this.ws.send(JSON.stringify({ type, payload }));
      });
    }
    this.ws.send(JSON.stringify({ type, payload }));
  }

  /**
   * Register message handler
   */
  on(messageType, handler) {
    if (!this.messageHandlers.has(messageType)) {
      this.messageHandlers.set(messageType, []);
    }
    this.messageHandlers.get(messageType).push(handler);
  }

  /**
   * Remove message handler
   */
  off(messageType, handler) {
    if (this.messageHandlers.has(messageType)) {
      const handlers = this.messageHandlers.get(messageType);
      const index = handlers.indexOf(handler);
      if (index > -1) {
        handlers.splice(index, 1);
      }
    }
  }

  /**
   * Handle incoming message
   */
  handleMessage(message) {
    const { type } = message;
    if (this.messageHandlers.has(type)) {
      this.messageHandlers.get(type).forEach(handler => {
        try {
          handler(message.payload);
        } catch (err) {
          console.error(`Error in message handler for ${type}:`, err);
        }
      });
    }
  }

  /**
   * Close connection
   */
  close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.connectionPromise = null;
    }
  }
}

// Singleton instance
const wsClient = new WebSocketClient();

export default wsClient;

