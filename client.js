// Frontend Client Logic for Shoonya Live Market Dashboard

// Configuration and State
const DEFAULT_STOCKS = [
  { exchange: 'NSE', token: '2885', symbol: 'RELIANCE', name: 'Reliance Industries Ltd.', category: 'Energy' },
  { exchange: 'NSE', token: '11536', symbol: 'TCS', name: 'Tata Consultancy Services Ltd.', category: 'IT Services' },
  { exchange: 'NSE', token: '1333', symbol: 'HDFCBANK', name: 'HDFC Bank Ltd.', category: 'Banking' },
  { exchange: 'NSE', token: '1594', symbol: 'INFY', name: 'Infosys Ltd.', category: 'IT Services' },
  { exchange: 'NSE', token: '4963', symbol: 'ICICIBANK', name: 'ICICI Bank Ltd.', category: 'Banking' }
];

let marketState = {};
let selectedSymbolKey = null; // Key of the stock selected for active technical charting
let localSocket = null;
let reconnectTimer = null;

// API Connection Configuration
const DEFAULT_BACKEND_PORT = 5600;

// Determine if the frontend is loaded externally (e.g. Vercel) instead of directly from the local server
const isLoadedExternally = !['localhost', '127.0.0.1'].some(h => window.location.hostname.includes(h)) && window.location.protocol !== 'file:';

// Point calls to local proxy server if running on Vercel or locally via file://
const API_BASE = (isLoadedExternally || window.location.protocol === 'file:') 
  ? `http://localhost:${DEFAULT_BACKEND_PORT}` 
  : '';

// Initialize State Object
function initMarketState() {
  DEFAULT_STOCKS.forEach(stock => {
    const key = `${stock.exchange}|${stock.token}`;
    marketState[key] = {
      ...stock,
      key: key,
      price: null,
      changePercent: '0.00',
      high: '--',
      low: '--',
      volume: '--',
      lastUpdate: null,
      history: [] // Array of historical price points (max 50)
    };
  });
  
  // Set default active symbol for chart
  selectedSymbolKey = `${DEFAULT_STOCKS[0].exchange}|${DEFAULT_STOCKS[0].token}`;
}

// Dom Elements Bootstrap
window.addEventListener('DOMContentLoaded', () => {
  initMarketState();
  renderTickerGrid();
  checkBackendStatus();
  connectLocalWebSocket();
  startChartRenderLoop();
  
  // Autoload .env settings status
  logToConsole('System bootstrapped. Pre-registered standard SMBG stocks.');
});

// Check proxy server connection status
async function checkBackendStatus() {
  try {
    const response = await fetch(`${API_BASE}/api/status`);
    const data = await response.json();
    
    const proxyBadge = document.getElementById('proxy-status');
    proxyBadge.innerHTML = '<i class="fa-solid fa-circle-nodes text-emerald-400"></i> Proxy Server: Connected';
    proxyBadge.className = 'px-3.5 py-1 rounded-full text-xs font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center gap-2';

    if (data.publicIp) {
      logToConsole(`[Network] Public IP detected: ${data.publicIp}`);
      logToConsole(`[Reminder] Ensure your public IP (${data.publicIp}) is whitelisted in Shoonya Prism portal API settings!`);
    }

    if (data.isLoggedIn) {
      updateShoonyaStatusBadge(true, data.userId);
      logToConsole(`[Proxy] Active Shoonya session detected for user: ${data.userId}`);
    } else {
      updateShoonyaStatusBadge(false);
      if (data.hasEnvCredentials) {
        logToConsole('[Proxy] .env credentials found. Press "Establish Real-Time Feed" to authenticate.');
      } else {
        logToConsole('[Proxy] Waiting for login. Fill credentials or configure the .env file.');
      }
    }
  } catch (err) {
    const proxyBadge = document.getElementById('proxy-status');
    proxyBadge.innerHTML = '<i class="fa-solid fa-triangle-exclamation text-rose-400 animate-pulse"></i> Proxy Server: Down';
    proxyBadge.className = 'px-3.5 py-1 rounded-full text-xs font-bold bg-rose-500/10 text-rose-400 border border-rose-500/20 flex items-center gap-2';
    logToConsole('[Error] Unable to reach local proxy server. Make sure it is running on your machine.', true);
  }
}

// Connect to Local Node.js WebSocket Bridge
function connectLocalWebSocket() {
  if (localSocket) {
    try { localSocket.close(); } catch(e) {}
  }

  // Connect to localhost if loaded externally (like Vercel) or via local file
  const isLocalHost = ['localhost', '127.0.0.1'].some(h => window.location.hostname.includes(h));
  const host = isLocalHost ? window.location.host : `localhost:${DEFAULT_BACKEND_PORT}`;
  
  // Local server has no SSL certificate, so always use ws:// for localhost/127.0.0.1 (even on HTTPS sites)
  const isConnectingToLocal = host.includes('localhost') || host.includes('127.0.0.1');
  const protocol = isConnectingToLocal ? 'ws:' : (window.location.protocol === 'https:' ? 'wss:' : 'ws:');
  
  const wsUrl = `${protocol}//${host}/ws`;

  logToConsole(`[WebSocket] Connecting to local bridge...`);
  
  localSocket = new WebSocket(wsUrl);

  localSocket.onopen = () => {
    logToConsole('[WebSocket] Local proxy bridge connected. Auto-subscribing stock watch tokens.');
    
    // Auto subscribe Shoonya proxy to all standard tokens
    Object.keys(marketState).forEach(tokenKey => {
      localSocket.send(JSON.stringify({
        action: 'subscribe',
        tokenKey: tokenKey
      }));
    });
  };

  localSocket.onmessage = (event) => {
    try {
      // Ignore simple heartbeat or non-JSON connection strings
      if (event.data === 'connected' || event.data === 'ping') {
        return;
      }
      const msg = JSON.parse(event.data);

      if (msg.type === 'connection_status') {
        updateShoonyaStatusBadge(msg.connected, msg.userId);
        logToConsole(`[Shoonya WS] ${msg.message}`);
      }

      if (msg.type === 'feed') {
        handleIncomingTick(msg.data);
      }

    } catch (err) {
      console.error('Failed to parse WebSocket message:', err);
    }
  };

  localSocket.onclose = () => {
    logToConsole('[WebSocket] Bridge disconnected. Retrying connection in 5 seconds...', true);
    updateShoonyaStatusBadge(false);
    
    // Attempt automatic reconnection
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectLocalWebSocket, 5000);
  };
}

// Process Real-Time Tick data
function handleIncomingTick(tick) {
  // Noren tick structures map: tk=token, e=exchange, lp=lastprice, pc=percentchange, h=high, l=low, v=volume
  const exchange = tick.e || 'NSE';
  const token = tick.tk;
  const key = `${exchange}|${token}`;

  const stock = marketState[key];
  if (!stock) return; // Unregistered symbol tick

  const oldPrice = stock.price;
  const newPrice = parseFloat(tick.lp || tick.o);

  if (isNaN(newPrice)) return;

  // Update properties
  stock.price = newPrice;
  stock.changePercent = tick.pc || stock.changePercent;
  stock.high = tick.h || stock.high;
  stock.low = tick.l || stock.low;
  stock.volume = tick.v || stock.volume;
  stock.lastUpdate = new Date().toLocaleTimeString();

  // Handle history (keep max 50 points)
  if (oldPrice !== newPrice) {
    stock.history.push(newPrice);
    if (stock.history.length > 50) {
      stock.history.shift();
    }
    
    // Print tick log to Event Logger
    logToConsole(`[Tick] ${stock.symbol}: Rs. ${newPrice.toFixed(2)} (${stock.changePercent}%)`);

    // Re-render and apply flashing animations
    updateCardUI(key, newPrice > oldPrice ? 'up' : 'down');
  } else {
    updateCardUI(key, null);
  }
}

// Update Shoonya active badge
function updateShoonyaStatusBadge(connected, userId = null) {
  const shoonyaBadge = document.getElementById('shoonya-status');
  if (connected) {
    shoonyaBadge.innerHTML = `<i class="fa-solid fa-circle-dot text-emerald-400 animate-ping"></i> Shoonya: Active (${userId})`;
    shoonyaBadge.className = 'px-3.5 py-1 rounded-full text-xs font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center gap-2';
  } else {
    shoonyaBadge.innerHTML = '<i class="fa-solid fa-circle-dot text-rose-500"></i> Shoonya: Disconnected';
    shoonyaBadge.className = 'px-3.5 py-1 rounded-full text-xs font-bold bg-rose-500/10 text-rose-400 border border-rose-500/20 flex items-center gap-2';
  }
}

// Render dynamic stock card grid
function renderTickerGrid() {
  const grid = document.getElementById('live-ticker-grid');
  grid.innerHTML = '';

  const keys = Object.keys(marketState);
  if (keys.length === 0) {
    grid.innerHTML = `
      <div class="col-span-full py-12 text-center text-slate-500">
        <p class="text-sm font-semibold">No stock watches registered.</p>
      </div>
    `;
    return;
  }

  keys.forEach(key => {
    const stock = marketState[key];
    const card = document.createElement('div');
    card.id = `card-${key.replace('|', '_')}`;
    card.className = `ticker-card p-5 flex flex-col justify-between ${key === selectedSymbolKey ? 'active-selected' : ''}`;
    card.onclick = () => selectSymbolForChart(key);

    card.innerHTML = `
      <div class="flex justify-between items-start mb-4">
        <div>
          <div class="flex items-center gap-1.5">
            <span class="text-white font-extrabold text-base tracking-wide">${stock.symbol}</span>
            <span class="text-[9px] bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded font-bold uppercase">${stock.exchange}</span>
          </div>
          <span class="text-[10px] text-slate-400 truncate block max-w-[160px] mt-0.5">${stock.name}</span>
        </div>
        <div class="text-right">
          <span id="price-${key.replace('|', '_')}" class="text-lg font-black block text-slate-300">--</span>
          <span id="change-${key.replace('|', '_')}" class="text-[10px] font-bold block text-slate-500">0.00%</span>
        </div>
      </div>

      <div class="grid grid-cols-3 gap-2 border-t border-slate-900 pt-3 mt-2 text-[9px] text-slate-400">
        <div>
          <span class="text-slate-500 block">High</span>
          <strong id="high-${key.replace('|', '_')}" class="text-slate-300 text-[10px]">${stock.high}</strong>
        </div>
        <div>
          <span class="text-slate-500 block">Low</span>
          <strong id="low-${key.replace('|', '_')}" class="text-slate-300 text-[10px]">${stock.low}</strong>
        </div>
        <div>
          <span class="text-slate-500 block">Volume</span>
          <strong id="vol-${key.replace('|', '_')}" class="text-slate-300 text-[10px] truncate max-w-[45px] block">${stock.volume}</strong>
        </div>
      </div>

      <!-- Sparkline Canvas wrapper -->
      <div class="h-10 mt-3 border-t border-slate-900/40 pt-2 flex items-center">
        <canvas id="spark-${key.replace('|', '_')}" class="w-full h-8 block"></canvas>
      </div>
    `;

    grid.appendChild(card);
    drawSparkline(key);
  });
}

// Update stock card UI values
function updateCardUI(key, direction) {
  const formattedKey = key.replace('|', '_');
  const stock = marketState[key];
  
  const card = document.getElementById(`card-${formattedKey}`);
  const priceText = document.getElementById(`price-${formattedKey}`);
  const changeText = document.getElementById(`change-${formattedKey}`);
  const highText = document.getElementById(`high-${formattedKey}`);
  const lowText = document.getElementById(`low-${formattedKey}`);
  const volText = document.getElementById(`vol-${formattedKey}`);

  if (!card) return;

  // Apply flashing class
  if (direction === 'up') {
    card.classList.remove('tick-flash-down');
    void card.offsetWidth; // Trigger reflow for animation restart
    card.classList.add('tick-flash-up');
  } else if (direction === 'down') {
    card.classList.remove('tick-flash-up');
    void card.offsetWidth;
    card.classList.add('tick-flash-down');
  }

  // Update text
  if (stock.price !== null) {
    priceText.textContent = `Rs. ${stock.price.toFixed(2)}`;
    changeText.textContent = `${stock.changePercent}%`;

    const isPositive = parseFloat(stock.changePercent) >= 0;
    changeText.className = `text-[10px] font-bold block ${isPositive ? 'text-emerald-400 glow-text-green' : 'text-rose-400 glow-text-red'}`;
    priceText.className = `text-lg font-black block ${isPositive ? 'text-emerald-300' : 'text-rose-300'}`;
  }

  highText.textContent = stock.high;
  lowText.textContent = stock.low;
  volText.textContent = stock.volume;

  // Draw sparkline
  drawSparkline(key);
}

// Draw a miniature sparkline on standard Canvas
function drawSparkline(key) {
  const formattedKey = key.replace('|', '_');
  const canvas = document.getElementById(`spark-${formattedKey}`);
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const history = marketState[key].history;
  
  // Set dimensions
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, rect.width, rect.height);

  if (history.length < 2) {
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, rect.height / 2);
    ctx.lineTo(rect.width, rect.height / 2);
    ctx.stroke();
    return;
  }

  const min = Math.min(...history);
  const max = Math.max(...history);
  const range = max - min === 0 ? 1 : max - min;

  const points = history.map((val, index) => {
    const x = (index / (history.length - 1)) * rect.width;
    const y = rect.height - 4 - ((val - min) / range) * (rect.height - 8);
    return { x, y };
  });

  const isPositive = parseFloat(marketState[key].changePercent) >= 0;
  
  ctx.strokeStyle = isPositive ? 'rgba(52, 211, 153, 0.7)' : 'rgba(248, 113, 113, 0.7)';
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.stroke();

  // Stroke area fill gradient
  ctx.lineTo(rect.width, rect.height);
  ctx.lineTo(0, rect.height);
  ctx.closePath();
  
  const fillGrad = ctx.createLinearGradient(0, 0, 0, rect.height);
  fillGrad.addColorStop(0, isPositive ? 'rgba(52, 211, 153, 0.08)' : 'rgba(248, 113, 113, 0.08)');
  fillGrad.addColorStop(1, 'transparent');
  ctx.fillStyle = fillGrad;
  ctx.fill();
}

// Select stock symbol card for central charting focus
function selectSymbolForChart(key) {
  selectedSymbolKey = key;
  
  // Update selected highlight card
  const cards = document.querySelectorAll('.ticker-card');
  cards.forEach(c => c.classList.remove('active-selected'));
  
  const card = document.getElementById(`card-${key.replace('|', '_')}`);
  if (card) card.classList.add('active-selected');

  const stock = marketState[key];
  document.getElementById('active-symbol-indicator').textContent = `${stock.symbol} (${stock.exchange})`;
  document.getElementById('chart-subtitle').textContent = `Tracking live ticks for ${stock.name}.`;
}

// Render active focused stock chart
function startChartRenderLoop() {
  const canvas = document.getElementById('active-stock-chart');
  const ctx = canvas.getContext('2d');

  function resizeAndDraw() {
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, rect.width, rect.height);

    const activeStock = marketState[selectedSymbolKey];
    if (!activeStock || activeStock.history.length < 2) {
      document.getElementById('chart-placeholder-msg').classList.remove('hidden');
      requestAnimationFrame(resizeAndDraw);
      return;
    }

    document.getElementById('chart-placeholder-msg').classList.add('hidden');

    const history = activeStock.history;
    const min = Math.min(...history);
    const max = Math.max(...history);
    const range = max - min === 0 ? 2 : max - min;

    // Draw grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.02)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = (i / 4) * rect.height;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(rect.width, y);
      ctx.stroke();
    }

    const points = history.map((val, index) => {
      const x = (index / (history.length - 1)) * rect.width;
      const y = rect.height - 20 - ((val - min) / range) * (rect.height - 40);
      return { x, y, val };
    });

    const isPositive = parseFloat(activeStock.changePercent) >= 0;
    
    // Draw Area Under Curve Gradient
    const areaGrad = ctx.createLinearGradient(0, 0, 0, rect.height);
    areaGrad.addColorStop(0, isPositive ? 'rgba(52, 211, 153, 0.12)' : 'rgba(248, 113, 113, 0.12)');
    areaGrad.addColorStop(1, 'transparent');
    
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.lineTo(rect.width, rect.height);
    ctx.lineTo(0, rect.height);
    ctx.closePath();
    ctx.fillStyle = areaGrad;
    ctx.fill();

    // Draw Ticks Line
    ctx.strokeStyle = isPositive ? '#10b981' : '#ef4444';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();

    // Highlight newest tick point
    const lastPoint = points[points.length - 1];
    ctx.fillStyle = isPositive ? '#34d399' : '#f87171';
    ctx.shadowBlur = 10;
    ctx.shadowColor = isPositive ? 'rgba(52, 211, 153, 0.5)' : 'rgba(248, 113, 113, 0.5)';
    
    ctx.beginPath();
    ctx.arc(lastPoint.x, lastPoint.y, 5, 0, 2 * Math.PI);
    ctx.fill();
    
    // Reset shadow values for subsequent frames
    ctx.shadowBlur = 0;

    // Draw Price Ticker label near newest tick point
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 10px Outfit';
    ctx.textAlign = 'right';
    ctx.fillText(`Rs. ${lastPoint.val.toFixed(2)}`, rect.width - 10, lastPoint.y - 10);

    requestAnimationFrame(resizeAndDraw);
  }

  requestAnimationFrame(resizeAndDraw);
}

// REST Form Handle Login Submit
async function handleLoginSubmit(event) {
  event.preventDefault();

  const userId = document.getElementById('api-user-id').value;
  const password = document.getElementById('api-password').value;
  const totpSecret = document.getElementById('api-totp-secret').value;
  const apiSecret = document.getElementById('api-secret').value;
  const vendorCode = document.getElementById('api-vendor-code').value;
  const imei = document.getElementById('api-imei').value;

  const btn = document.getElementById('login-btn');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner animate-spin"></i> Processing Multi-Factor Handshake...';

  try {
    const response = await fetch(`${API_BASE}/api/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ userId, password, totpSecret, apiSecret, vendorCode, imei })
    });

    const result = await response.json();

    if (result.success) {
      showToast('Login Successful', result.message, false);
      logToConsole(`[Proxy] Login completed for ${result.uname} (${result.userId}).`);
      
      // Auto re-subscribe WebSocket just in case
      connectLocalWebSocket();
    } else {
      showToast('Authentication Error', result.error, true);
      logToConsole(`[Error] Login rejected: ${result.error}`, true);
    }
  } catch (err) {
    showToast('Network Error', 'Proxy connection crashed. Please verify server logs.', true);
    logToConsole(`[Error] Failed to send auth request: ${err.message}`, true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-link"></i> Establish Real-Time Feed';
  }
}

// Add a Custom Token scrip to Board dynamically
function handleAddCustomSymbol() {
  const input = document.getElementById('search-symbol-input');
  const inputVal = input.value.trim();

  if (!inputVal || !inputVal.includes('|')) {
    showToast('Invalid Input Format', 'Use Exchange|Token format, E.g., NSE|3045', true);
    return;
  }

  const [exchange, token] = inputVal.split('|');
  const tokenKey = `${exchange.toUpperCase()}|${token}`;

  if (marketState[tokenKey]) {
    showToast('Token Registered', 'Symbol is already registered in active watcher lists.', true);
    return;
  }

  // Create a placeholder symbol name
  const symbolCode = `SYM_${token}`;
  
  marketState[tokenKey] = {
    exchange: exchange.toUpperCase(),
    token: token,
    symbol: symbolCode,
    name: `Custom Token scrip (NSE|${token})`,
    category: 'Custom Watch',
    key: tokenKey,
    price: null,
    changePercent: '0.00',
    high: '--',
    low: '--',
    volume: '--',
    lastUpdate: null,
    history: []
  };

  renderTickerGrid();

  // Send subscribe request to proxy bridge
  if (localSocket && localSocket.readyState === WebSocket.OPEN) {
    localSocket.send(JSON.stringify({
      action: 'subscribe',
      tokenKey: tokenKey
    }));
    logToConsole(`[WebSocket] Subscribed token scrip: ${tokenKey}`);
    showToast('Symbol Added', `Registered token scrip ${tokenKey} to active streamer list.`, false);
  }

  input.value = '';
}

// Helper: Show UI Toast Alerts
function showToast(title, message, isError = false) {
  const toast = document.getElementById('toast');
  const tTitle = document.getElementById('toast-title');
  const tMessage = document.getElementById('toast-message');
  const tIcon = document.getElementById('toast-icon');

  tTitle.textContent = title;
  tMessage.textContent = message;

  if (isError) {
    tIcon.innerHTML = '<i class="fa-solid fa-triangle-exclamation text-rose-500 animate-pulse"></i>';
  } else {
    tIcon.innerHTML = '<i class="fa-solid fa-circle-check text-emerald-400"></i>';
  }

  toast.className = 'fixed bottom-5 right-5 z-50 transform translate-y-0 opacity-100 transition-all duration-300 pointer-events-auto';

  setTimeout(() => {
    toast.className = 'fixed bottom-5 right-5 z-50 transform translate-y-20 opacity-0 transition-all duration-300 pointer-events-none';
  }, 4000);
}

// Helper: Print log to browser Event Console panel
function logToConsole(message, isError = false) {
  const logger = document.getElementById('event-logger');
  const logDiv = document.createElement('div');
  logDiv.className = isError ? 'text-rose-400' : 'text-emerald-400';
  
  const timestamp = new Date().toLocaleTimeString();
  logDiv.textContent = `[${timestamp}] ${message}`;
  
  logger.appendChild(logDiv);
  logger.scrollTop = logger.scrollHeight;
}

function clearConsoleLog() {
  document.getElementById('event-logger').innerHTML = '<div>[Console Logs Cleared] Ready...</div>';
}

// Simulated Demo Mode logic for weekend testing and outages
let demoInterval = null;
let isDemoMode = false;

function startDemoMode() {
  if (isDemoMode) return;
  
  isDemoMode = true;
  logToConsole('[Demo] Starting Simulated Market Feed...');
  showToast('Demo Mode Activated', 'Bypassing API authentication and running simulation. Perfect for weekend testing!', false);
  
  // Close local WS if open to prevent conflicts
  if (localSocket) {
    try { localSocket.close(); } catch(e) {}
  }
  
  // Update badges
  const shoonyaBadge = document.getElementById('shoonya-status');
  shoonyaBadge.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles text-amber-400 animate-pulse"></i> Shoonya: Simulated';
  shoonyaBadge.className = 'px-3.5 py-1 rounded-full text-xs font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20 flex items-center gap-2';

  // Seed initial prices if they are null
  Object.keys(marketState).forEach(key => {
    const stock = marketState[key];
    if (stock.price === null) {
      // Seed realistic base prices
      if (stock.symbol === 'RELIANCE') stock.price = 2450.50;
      else if (stock.symbol === 'TCS') stock.price = 3420.75;
      else if (stock.symbol === 'HDFCBANK') stock.price = 1610.20;
      else if (stock.symbol === 'INFY') stock.price = 1430.40;
      else if (stock.symbol === 'ICICIBANK') stock.price = 940.60;
      else stock.price = 500.00; // Custom symbols fallback

      stock.high = (stock.price * 1.01).toFixed(2);
      stock.low = (stock.price * 0.99).toFixed(2);
      stock.volume = '1.2M';
    }
  });

  // Start tick simulation loop
  clearInterval(demoInterval);
  demoInterval = setInterval(() => {
    const keys = Object.keys(marketState);
    if (keys.length === 0) return;
    
    // Select 1 to 2 random stocks to tick in this cycle
    const numTicks = Math.floor(Math.random() * 2) + 1;
    for (let i = 0; i < numTicks; i++) {
      const randomKey = keys[Math.floor(Math.random() * keys.length)];
      const stock = marketState[randomKey];
      
      const currentPrice = stock.price || 500.00;
      const tickSize = currentPrice * 0.0008 * (Math.random() > 0.48 ? 1 : -1);
      const newPrice = Math.max(1, currentPrice + tickSize);
      
      // Calculate realistic stats
      const prevClose = stock.history[0] || (currentPrice * 0.99);
      const pctChange = (((newPrice - prevClose) / prevClose) * 100).toFixed(2);
      
      const highVal = Math.max(parseFloat(stock.high) || 0, newPrice).toFixed(2);
      const lowVal = Math.min(parseFloat(stock.low) || 999999, newPrice).toFixed(2);
      const volNum = parseInt(stock.volume.replace(/[^0-9.]/g, '')) || 100000;
      const newVol = (volNum + Math.floor(Math.random() * 8000));
      
      const simulatedTick = {
        e: stock.exchange,
        tk: stock.token,
        lp: newPrice.toFixed(2),
        pc: (pctChange > 0 ? '+' : '') + pctChange,
        h: highVal,
        l: lowVal,
        v: newVol > 1000000 ? (newVol / 1000000).toFixed(2) + 'M' : (newVol / 1000).toFixed(0) + 'K'
      };
      
      handleIncomingTick(simulatedTick);
    }
  }, 1000);
}
