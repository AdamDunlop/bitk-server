const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt"); // optional if you want hashed passwords

// ===== CONFIG =====
const PORT = process.env.PORT || 3001;
const USERS_FILE = path.join(__dirname, "users.json");
const ASSETS_PATH = path.join(__dirname, "assets");
const SCRIPTS_DIR = path.join(__dirname, "scripts");

// ===== EXPRESS APP =====
const app = express();

// ===== CORS =====
app.use(
  cors({
    origin: ["http://localhost:3000", "http://localhost:3001", "https://www.cyloware.com"],
    credentials: true,
  })
);

// ===== JSON PARSING =====
app.use(express.json());

// ===== STATIC FILES =====
app.use("/audio", express.static(path.join(ASSETS_PATH, "audio")));
app.use("/images", express.static(path.join(ASSETS_PATH, "images")));
app.use("/video", express.static(path.join(ASSETS_PATH, "video")));

// ===== USERS STORAGE =====
function readUsers() {
  if (!fs.existsSync(USERS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf-8"));
  } catch (err) {
    console.error("Error parsing users.json:", err);
    return {};
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), "utf-8");
}

// ===== ROUTES =====
app.get("/", (req, res) => {
  res.send("BitKaraoke server is running. Use /audio, /images, /video paths.");
});

// Signup route
app.post("/signup", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ success: false, message: "Missing credentials" });

  const users = readUsers();
  if (users[username]) {
    return res.json({ success: false, message: "Username already exists" });
  }

  // Optional: hash password
  const hash = await bcrypt.hash(password, 12);

  users[username] = { password: hash };
  saveUsers(users);

  return res.json({ success: true, message: "User created! Please log in." });
});

// Login route
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const users = readUsers();
  const user = users[username];

  if (!user) return res.status(401).json({ success: false, message: "Invalid credentials" });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ success: false, message: "Invalid credentials" });

  return res.json({ success: true, username });
});

// ===== HTTP + SOCKET.IO =====
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: ["http://localhost:3000", "http://localhost:3001", "https://www.cyloware.com"],
    credentials: true,
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling'],
});

// ===== GLOBAL STATE =====
let activeUsers = [];
let rooms = {};      // key: roomName, value: room object
let roomList = [];   // array of { name, admin }

// ===== LOAD SCRIPTS =====
function loadAllScripts() {
  if (!fs.existsSync(SCRIPTS_DIR)) return {};
  const files = fs.readdirSync(SCRIPTS_DIR).filter(f => f.endsWith(".json"));
  const scripts = {};

  files.forEach(file => {
    const raw = fs.readFileSync(path.join(SCRIPTS_DIR, file), "utf-8");
    const json = JSON.parse(raw);
    if (!json.scripts) return;
    json.scripts.forEach(script => {
      scripts[script.name] = { ...script, type: json.type };
    });
  });

  return scripts;
}

const SCRIPTS = loadAllScripts();
const allScripts = Object.values(SCRIPTS);

// ===== SOCKET.IO CONNECTION =====
io.on("connection", (socket) => {
  console.log(`✅ New connection: ${socket.id}`);

  // Welcome message
  socket.emit("welcome", { message: "Connected to BitKaraoke server", socketId: socket.id });

  // ----- LOGIN -----
  socket.on("login", ({ username }, callback) => {
    socket.data.username = username;
    if (!activeUsers.includes(username)) activeUsers.push(username);

    socket.emit("rooms", roomList);
    socket.emit("scriptListFull", allScripts);
    io.emit("activeUsers", activeUsers);

    if (callback) callback({ success: true, username });
    console.log("Active users:", activeUsers);
  });

  // ----- CREATE ROOM -----
  socket.on("createRoom", ({ roomName }) => {
    if (!socket.data.username) return socket.emit("errorMessage", "Unauthorized");
    if (rooms[roomName]) return socket.emit("errorMessage", "Room name already taken");

    const userHasRoom = Object.values(rooms).some(r => r.admin === socket.data.username);
    if (userHasRoom) return socket.emit("errorMessage", "You already have a room");

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

    roomList = Object.keys(rooms).map(name => ({ name, admin: rooms[name].admin }));
    io.emit("rooms", roomList);
    console.log("Room created:", roomName);
  });

  // ----- DELETE ROOM -----
  socket.on("deleteRoom", ({ roomName }) => {
    const room = rooms[roomName];
    if (!room) return socket.emit("errorMessage", "Room not found");
    if (room.admin !== socket.data.username) return socket.emit("errorMessage", "Only admin can delete room");

    delete rooms[roomName];
    roomList = Object.keys(rooms).map(name => ({ name, admin: rooms[name].admin }));
    io.emit("rooms", roomList);
    console.log("Room deleted:", roomName);
  });

  // ----- GET STATE -----
  socket.on("getState", (data, callback) => {
    const socketUsers = Array.from(io.sockets.sockets.values()).map(s => ({
      id: s.id,
      username: s.data.username || null,
      hasUsername: !!s.data.username,
    }));

      if (callback) callback({
        activeUsers,
        rooms: roomList,
        totalSockets: io.engine.clientsCount,
        socketUsers,
        timestamp: new Date().toISOString(),
      });
    });

    socket.on("joinRoom", ({ room, username }) => {
      if (!socket.data.username) socket.data.username = username;

      const roomObj = rooms[room];
      if (!roomObj) {
        return socket.emit("errorMessage", "Room does not exist");
      }

      roomObj.members[username] = socket.id;

      // Join Socket.IO room
      socket.join(room);

      // Send room state to all members
      io.to(room).emit("roomState", {
        users: Object.keys(roomObj.members),
        admin: roomObj.admin
      });
      socket.emit("scriptListFull", allScripts);
      console.log(`${username} joined room ${room}`);
    });

  socket.on("leaveRoom", ({ room }) => {
    const roomObj = rooms[room];
    if (!roomObj) return;

    delete roomObj.members[socket.data.username];
    socket.leave(room);

    io.to(room).emit("roomState", {
      users: Object.keys(roomObj.members),
      admin: roomObj.admin
    });

    console.log(`${socket.data.username} left room ${room}`);
  });

  /* ---------------- SELECT SCRIPT ---------------- */
  socket.on("selectScript", ({ room, scriptId }) => {
    const roomInfo = rooms[room];
    if (!roomInfo) return;

    socket.join(room);

    if (roomInfo.script === scriptId) {
       roomInfo.script = null;
       roomInfo.scriptData = null;
       roomInfo.karaokeStep = 0;
       roomInfo.baseDelay = 0;
       roomInfo.punctuationDelay = 0;
       roomInfo.currentLineIndex = 0;
       roomInfo.currentCharIndex = 0;
       roomInfo.sceneStarted = false;

    io.to(room).emit("scriptSelected", {
        scriptId: null,
        scriptData: null,
        karaokeStep: 0,
        baseDelay: 0,
        punctuationDelay: 0,
        admin: roomInfo.admin,
      });

       console.log(`Script deselected in room ${room}`);
       return;
     }


    const scriptObj = allScripts.find((s) => s.id === scriptId);
    if (!scriptObj) {
      console.log("Script not found:", scriptId);
      return;
    }

    roomInfo.script = scriptId;
    roomInfo.scriptData = Object.freeze({ ...scriptObj });
    roomInfo.karaokeStep = scriptObj.karaokeStep ?? 2;
    roomInfo.baseDelay = scriptObj.baseDelay ?? 90;
    roomInfo.punctuationDelay = scriptObj.punctuationDelay ?? 300;
    roomInfo.currentLineIndex = 0;
    roomInfo.currentCharIndex = 0;
    roomInfo.sceneStarted = false;

    io.to(room).emit("scriptSelected", {
      scriptId,
      scriptData: roomInfo.scriptData,
      karaokeStep: roomInfo.karaokeStep,
      baseDelay: roomInfo.baseDelay,
      punctuationDelay: roomInfo.punctuationDelay,
      admin: roomInfo.admin,
    });
  });

  /* ---------------- CHARACTER ASSIGNMENT ---------------- */
  socket.on("assignCharacter", ({ room, character, username }) => {
    const roomInfo = rooms[room];
    if (!roomInfo || roomInfo.characterAssignments[character]) return;
    roomInfo.characterAssignments[character] = username;
    io.to(room).emit("characterAssignments", roomInfo.characterAssignments);
  });

  socket.on("unselectCharacter", ({ room, character, username }) => {
    const roomInfo = rooms[room];
    if (!roomInfo) return;
    if (roomInfo.characterAssignments[character] === username) {
      delete roomInfo.characterAssignments[character];
      io.to(room).emit("characterAssignments", roomInfo.characterAssignments);
    }
  });

  /* ---------------- START SCENE ---------------- */
  socket.on("startScene", ({ room }) => {
    const roomInfo = rooms[room];
    if (!roomInfo || !roomInfo.scriptData) return;

    if (roomInfo.sceneStarted) {
      socket.emit("errorMessage", "Scene is already running");
      return;
    }

    const allAssigned = roomInfo.scriptData.characters.every(
      (ch) => roomInfo.characterAssignments[ch]
    );
    if (!allAssigned) {
      socket.emit("errorMessage", "All characters must be assigned");
      return;
    }

    roomInfo.sceneStarted = true;
    roomInfo.currentLineIndex = 0;
    roomInfo.currentCharIndex = 0;

    io.to(room).emit("sceneStarted", {
      scriptData: roomInfo.scriptData,
      characterAssignments: roomInfo.characterAssignments,
      currentLineIndex: roomInfo.currentLineIndex,
      currentCharIndex: roomInfo.currentCharIndex,
    });

    function advanceChar() {
      if (!roomInfo.sceneStarted) return;
      const line = roomInfo.scriptData.lines[roomInfo.currentLineIndex];
      if (!line) return;

      let step = 1;
      let delay = roomInfo.baseDelay;

      for (
        let i = 0;
        i < roomInfo.karaokeStep && roomInfo.currentCharIndex + i < line.text.length;
        i++
      ) {
        const char = line.text[roomInfo.currentCharIndex + i];
        step = i + 1;
        if (/[.,!?]/.test(char)) {
          delay = roomInfo.punctuationDelay;
          break;
        }
      }

      roomInfo.currentCharIndex += step;

      io.to(room).emit("lineProgress", {
        currentLineIndex: roomInfo.currentLineIndex,
        currentCharIndex: roomInfo.currentCharIndex,
      });

      if (roomInfo.currentCharIndex >= line.text.length) {
        roomInfo.currentLineIndex++;
        roomInfo.currentCharIndex = 0;

        if (roomInfo.currentLineIndex >= roomInfo.scriptData.lines.length) {
          roomInfo.sceneStarted = false;
          io.to(room).emit("sceneFinished");
          return;
        }
      }

      roomInfo.lineTimer = setTimeout(advanceChar, delay);
    }

    advanceChar();
  });

  /* ---------------- RESET ---------------- */
  socket.on("resetAssignments", ({ room }) => {
    const roomInfo = rooms[room];
    if (!roomInfo) return;

    roomInfo.characterAssignments = {};
    io.to(room).emit("characterAssignments", {});
  });

  /* ---------------- STOP SCENE ---------------- */
  socket.on("stopScene", ({ room }) => {
    const roomInfo = rooms[room];
    if (!roomInfo) return;

    if (roomInfo.lineTimer) clearTimeout(roomInfo.lineTimer);
    roomInfo.lineTimer = null;

    roomInfo.sceneStarted = false;
    roomInfo.currentLineIndex = 0;
    roomInfo.currentCharIndex = 0;

    io.to(room).emit("sceneStopped");
  });

  /* ---------------- END SCENE ---------------- */
  socket.on("endScene", ({ room }) => {
    const roomInfo = rooms[room];
    if (!roomInfo) return;

    if (roomInfo.lineTimer) clearTimeout(roomInfo.lineTimer);
    roomInfo.lineTimer = null;

    roomInfo.sceneStarted = false;
    roomInfo.currentLineIndex = 0;
    roomInfo.currentCharIndex = 0;

    roomInfo.characterAssignments = {};
    io.to(room).emit("characterAssignments", {});
    io.to(room).emit("sceneStopped");
  });



  // ----- PING -----
  socket.on("ping", (data, callback) => {
    if (callback) callback({ pong: true, timestamp: new Date().toISOString() });
    io.emit("activeUsers", activeUsers);
    io.emit("rooms", roomList);
  });

  // ----- DISCONNECT -----
  socket.on("disconnect", () => {
    const username = socket.data.username;
    if (username) {
      const index = activeUsers.indexOf(username);
      if (index !== -1) activeUsers.splice(index, 1);
      io.emit("activeUsers", activeUsers);
    }
    console.log("Socket disconnected:", socket.id);
  });
});

// ===== START SERVER =====
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ BitKaraoke server running on port ${PORT}`);
});