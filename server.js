const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const dotenv = require('dotenv');
const { authenticator } = require('otplib');

// Load environment variables
dotenv.config();

const app = express();
app.use(express.json());

// Enable CORS middleware (allows local file:/// access to server)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type,Authorization');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.static(__dirname)); // Serve frontend files

const PORT = process.env.PORT || 5000;
const server = http.createServer(app);

// Local WebSocket Server (broadcaster to frontend)
const localWss = new WebSocket.Server({ noServer: true });

// Active Shoonya Session State
let shoonyaSession = {
  susertoken: null,
  userId: null,
  ws: null,
  isLoggedIn: false,
  subscribedTokens: new Set() // Track what tokens the client is subscribed to
};

// Periodic heartbeat to Shoonya WebSocket (type: "h" every 30 seconds)
let shoonyaHeartbeatInterval = null;

// Upgrade local server requests to local WebSocket connection
server.on('upgrade', (request, socket, head) => {
  localWss.handleUpgrade(request, socket, head, (ws) => {
    localWss.emit('connection', ws, request);
  });
});

// Helper: SHA256 hashing
function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// REST API endpoint: Check status
app.get('/api/status', async (req, res) => {
  let publicIp = 'Unknown';
  try {
    const ipRes = await fetch('https://api.ipify.org?format=json', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      }
    });
    if (ipRes.ok) {
      const ipData = await ipRes.json();
      publicIp = ipData.ip;
    }
  } catch (e) {
    console.warn('[Shoonya Proxy] Failed to detect public IP:', e.message);
  }

  res.json({
    isLoggedIn: shoonyaSession.isLoggedIn,
    userId: shoonyaSession.userId,
    subscribedCount: shoonyaSession.subscribedTokens.size,
    hasEnvCredentials: !!(process.env.SHOONYA_USER_ID && process.env.SHOONYA_PASSWORD && process.env.SHOONYA_TOTP_SECRET),
    publicIp: publicIp
  });
});

// REST API endpoint: Login
app.post('/api/login', async (req, res) => {
  try {
    // Check if credentials are provided in request body, otherwise fallback to .env
    const userId = (req.body.userId || process.env.SHOONYA_USER_ID || '').trim();
    const password = req.body.password || process.env.SHOONYA_PASSWORD || '';
    const totpSecret = (req.body.totpSecret || process.env.SHOONYA_TOTP_SECRET || '').trim();
    const apiSecret = (req.body.apiSecret || process.env.SHOONYA_API_SECRET || '').trim();
    const vendorCode = (req.body.vendorCode || process.env.SHOONYA_VENDOR_CODE || '').trim();
    const imei = (req.body.imei || process.env.SHOONYA_IMEI || '').trim();

    if (!userId || !password || !totpSecret || !apiSecret || !vendorCode || !imei) {
      return res.status(400).json({
        success: false,
        error: 'Missing required credentials. Please fill all fields or configure the .env file.'
      });
    }

    console.log(`[Shoonya Proxy] Attempting login for user: ${userId}`);

    // 1. Generate 2FA TOTP code dynamically
    let totpCode;
    try {
      totpCode = authenticator.generate(totpSecret);
    } catch (totpErr) {
      console.error('[Shoonya Proxy] TOTP generation failed:', totpErr);
      return res.status(400).json({
        success: false,
        error: 'Invalid 2FA TOTP Secret Key. Please check its format.'
      });
    }

    // 2. Hash Password (SHA256)
    const hashedPassword = sha256(password);

    // 3. AppKey is SHA256 of UserID + APISecret
    const appkey = sha256(`${userId}|${apiSecret}`);

    // 4. Construct NorenAPI request payload (jData)
    const jData = {
      apkversion: '1.0.0',
      uid: userId,
      pwd: hashedPassword,
      factor2: totpCode,
      vc: vendorCode,
      appkey: appkey,
      imei: imei,
      source: 'API'
    };

    // Serialize and URL-encode jData
    const formBody = `jData=${encodeURIComponent(JSON.stringify(jData))}`;

    console.log('[Shoonya Proxy] Sending authentication request...');

    // 5. REST Call to QuickAuthenticate
    const response = await fetch('https://api.shoonya.com/NorenWClientTP/QuickAuthenticate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, *.*'
      },
      body: formBody
    });

    const responseText = await response.text();
    
    // Check if the response is HTML (indicates a 502, 403, or other web server/Cloudflare error page)
    if (responseText.trim().startsWith('<html') || responseText.trim().startsWith('<!DOCTYPE html') || response.status >= 500) {
      console.error(`[Shoonya Proxy] Server error (${response.status}):`, responseText.substring(0, 500));
      let errorMsg = 'Shoonya API server is currently unreachable or experiencing instability (502 Bad Gateway). Please try again in a few moments.';
      if (response.status === 403) {
        errorMsg = 'Access Denied (403 Forbidden) from Shoonya API. Please verify IP whitelisting or request headers.';
      } else if (response.status === 404) {
        errorMsg = 'Shoonya API endpoint not found (404). Please verify the base URL.';
      }
      return res.status(response.status >= 400 && response.status < 600 ? response.status : 502).json({
        success: false,
        error: errorMsg
      });
    }

    let result;
    try {
      result = JSON.parse(responseText);
    } catch (parseErr) {
      console.error('[Shoonya Proxy] Failed to parse API response as JSON. Raw response:', responseText);
      return res.status(500).json({
        success: false,
        error: `Invalid JSON response from Shoonya API: ${responseText.substring(0, 100)}`
      });
    }

    if (result.stat !== 'Ok') {
      console.error('[Shoonya Proxy] Authentication rejected:', result.emsg || result);
      return res.status(401).json({
        success: false,
        error: result.emsg || 'Authentication failed. Please verify your credentials.'
      });
    }

    console.log('[Shoonya Proxy] REST Authentication successful! Token obtained.');

    // Save session details
    shoonyaSession.susertoken = result.susertoken;
    shoonyaSession.userId = userId;
    shoonyaSession.isLoggedIn = true;

    // 6. Connect to Shoonya WebSocket immediately
    await connectShoonyaWebSocket(userId, result.susertoken);

    res.json({
      success: true,
      message: 'Logged in successfully and connected to real-time feed!',
      uname: result.uname,
      userId: userId
    });

  } catch (err) {
    console.error('[Shoonya Proxy] Login process crashed:', err);
    res.status(500).json({
      success: false,
      error: `Internal Server Error: ${err.message}`
    });
  }
});

// Function to establish connection to Shoonya's WebSocket server
function connectShoonyaWebSocket(userId, susertoken) {
  return new Promise((resolve, reject) => {
    if (shoonyaSession.ws) {
      console.log('[Shoonya Proxy] Closing existing Shoonya WebSocket connection...');
      try {
        shoonyaSession.ws.close();
      } catch (e) {}
    }

    console.log('[Shoonya Proxy] Initializing WebSocket connection to Shoonya (wss://api.shoonya.com/NorenWSTP/)...');
    
    const ws = new WebSocket('wss://api.shoonya.com/NorenWSTP/');
    shoonyaSession.ws = ws;

    // WebSocket Open Handler
    ws.on('open', () => {
      console.log('[Shoonya Proxy] Shoonya WebSocket channel opened. Sending connect handshake...');
      
      // Handshake Connect Payload
      const connectMessage = {
        t: 'c',
        uid: userId,
        actid: userId,
        susertoken: susertoken,
        source: 'API'
      };

      ws.send(JSON.stringify(connectMessage));
      resolve();
    });

    // WebSocket Message Handler (ticks received from Finvasia)
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        
        // Quietly log heartbeat response
        if (msg.t === 'h') {
          return;
        }

        // Broadcast Shoonya feed messages to all connected local clients (browsers)
        localWss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'feed',
              data: msg
            }));
          }
        });

      } catch (err) {
        console.error('[Shoonya Proxy] Failed to parse Shoonya WebSocket message:', err);
      }
    });

    // WebSocket Error Handler
    ws.on('error', (err) => {
      console.error('[Shoonya Proxy] Shoonya WebSocket error:', err);
    });

    // WebSocket Close Handler
    ws.on('close', (code, reason) => {
      console.warn(`[Shoonya Proxy] Shoonya WebSocket closed (Code: ${code}, Reason: ${reason || 'None'}).`);
      shoonyaSession.isLoggedIn = false;
      stopShoonyaHeartbeat();
      
      // Broadcast disconnect to local clients
      localWss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: 'connection_status',
            connected: false,
            message: 'Shoonya WebSocket connection lost.'
          }));
        }
      });
    });

    // Start application-level heartbeat ping
    startShoonyaHeartbeat(ws);
  });
}

// Shoonya WebSocket Heartbeat generator
function startShoonyaHeartbeat(ws) {
  stopShoonyaHeartbeat();

  console.log('[Shoonya Proxy] Starting heartbeat pinger (30s interval)...');
  shoonyaHeartbeatInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: 'h' }));
    }
  }, 30000);
}

function stopShoonyaHeartbeat() {
  if (shoonyaHeartbeatInterval) {
    clearInterval(shoonyaHeartbeatInterval);
    shoonyaHeartbeatInterval = null;
  }
}

// Local WebSocket (frontend browser client connection)
localWss.on('connection', (ws) => {
  console.log('[Local WebSocket] New frontend browser client connected.');

  // Send initial connection status
  ws.send(JSON.stringify({
    type: 'connection_status',
    connected: shoonyaSession.isLoggedIn,
    userId: shoonyaSession.userId,
    message: shoonyaSession.isLoggedIn ? 'Connected to Shoonya!' : 'Waiting for login...'
  }));

  // Re-subscribe Shoonya server to any already subscribed tokens for new clients
  if (shoonyaSession.isLoggedIn && shoonyaSession.ws && shoonyaSession.ws.readyState === WebSocket.OPEN) {
    shoonyaSession.subscribedTokens.forEach((tokenKey) => {
      shoonyaSession.ws.send(JSON.stringify({
        t: 't',
        k: tokenKey
      }));
    });
  }

  // Handle messages from frontend
  ws.on('message', (message) => {
    try {
      const payload = JSON.parse(message.toString());

      // If user wants to subscribe to a token
      if (payload.action === 'subscribe') {
        const tokenKey = payload.tokenKey; // e.g. "NSE|2885"
        console.log(`[Local WebSocket] Client requested subscribe to: ${tokenKey}`);
        
        shoonyaSession.subscribedTokens.add(tokenKey);

        // Forward subscription to Shoonya WebSocket if active
        if (shoonyaSession.ws && shoonyaSession.ws.readyState === WebSocket.OPEN) {
          shoonyaSession.ws.send(JSON.stringify({
            t: 't',
            k: tokenKey
          }));
        }
      }

      // If user wants to unsubscribe from a token
      if (payload.action === 'unsubscribe') {
        const tokenKey = payload.tokenKey;
        console.log(`[Local WebSocket] Client requested unsubscribe from: ${tokenKey}`);
        
        shoonyaSession.subscribedTokens.delete(tokenKey);

        // Forward unsubscribe to Shoonya WebSocket
        if (shoonyaSession.ws && shoonyaSession.ws.readyState === WebSocket.OPEN) {
          shoonyaSession.ws.send(JSON.stringify({
            t: 'u',
            k: tokenKey
          }));
        }
      }

    } catch (err) {
      console.error('[Local WebSocket] Failed to process message from client:', err);
    }
  });

  ws.on('close', () => {
    console.log('[Local WebSocket] Frontend browser client disconnected.');
  });
});

// Start Node server
server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🚀 Shoonya Local Proxy Server Running!`);
  console.log(`👉 Access Dashboard: http://localhost:${PORT}`);
  console.log(`======================================================\n`);
});
