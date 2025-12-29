// server.js - CLEAN WORKING VERSION
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();

// ===== SIMPLE CORS FIX =====
// Use a simpler CORS configuration
const corsOptions = {
  origin: function (origin, callback) {
    // List of allowed origins
    const allowedOrigins = [
      "http://localhost:3000",
      "http://localhost:3001",
      "https://www.cyloware.com"
    ];
    
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.includes(origin)) {
      console.log(`✅ CORS allowed: ${origin}`);
      return callback(null, true);
    } else {
      console.error(`❌ CORS blocked: ${origin}`);
      return callback(new Error(`Origin ${origin} not allowed`), false);
    }
  },
  credentials: true
};

// Apply CORS middleware
app.use(cors(corsOptions));

// Parse JSON
app.use(express.json());

// ===== STATIC FILES =====
const ASSETS_PATH = path.join(__dirname, "assets");
const USERS_FILE = path.join(__dirname, "users.json");

app.use("/audio", express.static(path.join(ASSETS_PATH, "audio")));
app.use("/images", express.static(path.join(ASSETS_PATH, "images")));
app.use("/video", express.static(path.join(ASSETS_PATH, "video"), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".mp4")) {
      res.setHeader("Content-Type", "video/mp4");
    } else if (filePath.endsWith(".mov")) {
      res.setHeader("Content-Type", "video/quicktime");
    }
  },
}));

// ===== ROUTES =====
app.get("/", (req, res) => {
  res.send("BitKaraoke server is running. Use /images, /video, /audio paths.");
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  console.log("Login request received:", req.body);

  if (username === "test123" && password === "test") {
    return res.json({ success: true });
  } else {
    return res.json({ success: false, message: "Invalid credentials" });
  }
});

app.post("/signup", (req, res) => {
  const { username, password } = req.body;
  console.log("Signup request received:", req.body);

  if (!username || !password) {
    return res.json({ success: false, message: "Missing credentials" });
  }

  const users = readUsers();

  if (users.find((u) => u.username === username)) {
    return res.json({ success: false, message: "Username already exists" });
  }

  users.push({ username, password });
  saveUsers(users);

  return res.json({ success: true, message: "User created! Please log in." });
});

function readUsers() {
  if (!fs.existsSync(USERS_FILE)) return [];
  const data = fs.readFileSync(USERS_FILE, "utf-8");
  try {
    return JSON.parse(data);
  } catch (err) {
    console.error("Error parsing users.json:", err);
    return [];
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), "utf-8");
}

// ===== CREATE HTTP SERVER =====
const server = http.createServer(app);

// ===== SOCKET.IO =====
const io = new Server(server, {
  cors: {
    origin: ["http://localhost:3000", "http://localhost:3001", "https://www.cyloware.com"],
    credentials: true,
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling'],
  path: '/socket.io/'
});

console.log("Socket.IO initialized");

// ===== GLOBAL STATE =====
let rooms = {};
let roomList = [];
let activeUsers = [];

// ===== LOAD SCRIPTS =====
const scriptsDir = path.join(__dirname, "scripts");

function loadAllScripts() {
  if (!fs.existsSync(scriptsDir)) return {};

  const scriptFiles = fs.readdirSync(scriptsDir).filter((f) => f.endsWith(".json"));
  const scripts = {};

  scriptFiles.forEach((file) => {
    const filePath = path.join(scriptsDir, file);
    const rawData = fs.readFileSync(filePath, "utf-8");
    const json = JSON.parse(rawData);
    if (!json.scripts) return;

    json.scripts.forEach((script) => {
      scripts[script.name] = { ...script, type: json.type };
    });
  });

  return scripts;
}

const SCRIPTS = loadAllScripts();
const allScripts = Object.values(SCRIPTS);

// ===== SOCKET HANDLERS =====
io.on("connection", (socket) => {
  console.log("✅ Socket connected:", socket.id);
  console.log("🌐 Origin:", socket.handshake.headers.origin);

  socket.emit("welcome", {
    message: "Connected to BitKaraoke server",
    socketId: socket.id
  });

  socket.on("login", ({ username }, callback) => {
    console.log("Login event:", username);
    
    socket.data.username = username;
    
    if (!activeUsers.includes(username)) {
      activeUsers.push(username);
    }
    
    io.emit("activeUsers", activeUsers);
    socket.emit("rooms", roomList);
    socket.emit("scriptListFull", allScripts);
    
    if (callback) {
      callback({ success: true, username });
    }
    
    console.log("Active users:", activeUsers);
  });

  socket.on("createRoom", ({ roomName }) => {
    if (!socket.data.username) {
      socket.emit("errorMessage", "Unauthorized");
      return;
    }

    if (rooms[roomName]) {
      socket.emit("errorMessage", "Room name already taken");
      return;
    }

    const userAlreadyHasRoom = Object.values(rooms).some(
      (room) => room.admin === socket.data.username
    );
    
    if (userAlreadyHasRoom) {
      socket.emit("errorMessage", "You already have a room");
      return;
    }

    rooms[roomName] = {
      admin: socket.data.username,
      members: {},
      script: null,
      scriptData: null,
      characterAssignments: {},
      sceneStarted: false,
      currentLineIndex: 0,
      currentCharIndex: 0,
      karaokeStep: 2,
      baseDelay: 90,
      punctuationDelay: 300,
      lineTimer: null,
    };

    roomList = Object.keys(rooms).map((name) => ({
      name,
      admin: rooms[name].admin,
    }));

    io.emit("rooms", roomList);
    console.log("Room created:", roomName);
  });

  // Add other socket handlers as needed...

  socket.on("disconnect", () => {
    const username = socket.data?.username;
    
    if (username) {
      const index = activeUsers.indexOf(username);
      if (index !== -1) {
        activeUsers.splice(index, 1);
        io.emit("activeUsers", activeUsers);
      }
    }
    
    console.log("Socket disconnected:", socket.id);
  });
});

// ===== START SERVER =====
const PORT = 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});