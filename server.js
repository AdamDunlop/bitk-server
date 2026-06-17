const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");

// ===== CONFIG =====
const PORT = process.env.PORT || 3001;
const USERS_FILE = path.join(__dirname, "users.json");
const ASSETS_PATH = path.join(__dirname, "assets");
const SCRIPTS_DIR = path.join(__dirname, "scripts");

// ===== EXPRESS =====
const app = express();

app.use(cors({
  origin: [
    "http://localhost:8081",
    "http://10.0.0.77:8081",
    "http://localhost:3000",
    "http://localhost:3001",
    "https://www.cyloware.com"
  ],
  credentials: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.options(/.*/, cors());
app.use(express.json());

// ===== STATIC =====
app.use("/audio", express.static(path.join(ASSETS_PATH, "audio")));
app.use("/images", express.static(path.join(ASSETS_PATH, "images")));
app.use("/video", express.static(path.join(ASSETS_PATH, "video")));

// ===== USERS =====
function readUsers() {
  if (!fs.existsSync(USERS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf-8"));
  } catch (e) {
    console.error("users.json error:", e);
    return {};
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// ===== ROUTES =====
app.get("/", (req, res) => {
  res.send("BitKaraoke server is running.");
});

// SIGNUP
app.post("/signup", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.json({ success: false, message: "Missing credentials" });

  const users = readUsers();
  if (users[username])
    return res.json({ success: false, message: "User exists" });

  const hash = await bcrypt.hash(password, 12);
  users[username] = { password: hash };
  saveUsers(users);

  res.json({ success: true });
});

// LOGIN (FIXED)
app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  const users = readUsers();
  const user = users[username];

  if (!user)
    return res.json({ success: false, message: "Invalid login" });

  const match = await bcrypt.compare(password, user.password);

  if (!match)
    return res.json({ success: false, message: "Invalid login" });

  res.json({ success: true, username });
});

// ===== SERVER + SOCKET =====
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: [
      "http://localhost:8081",
      "http://localhost:3000",
      "http://localhost:3001",
      "http://10.0.0.77:8081",
      "https://www.cyloware.com"
    ],
    credentials: true,
    methods: ["GET", "POST"]
  },
  transports: ["websocket", "polling"],
});

// ===== STATE =====
const activeUsers = new Map(); // username -> socket.id
let rooms = {};
let roomList = [];

// ===== SCRIPTS =====
function loadAllScripts() {
  if (!fs.existsSync(SCRIPTS_DIR)) return {};
  const files = fs.readdirSync(SCRIPTS_DIR).filter(f => f.endsWith(".json"));

  const scripts = {};
  files.forEach(file => {
    const json = JSON.parse(fs.readFileSync(path.join(SCRIPTS_DIR, file)));
    if (!json.scripts) return;

    json.scripts.forEach(script => {
      scripts[script.name] = { ...script, type: json.type };
    });
  });

  return scripts;
}

const SCRIPTS = loadAllScripts();
const allScripts = Object.values(SCRIPTS);

// ===== HELPERS =====
function updateRoomList() {
  roomList = Object.keys(rooms).map(name => ({
    name,
    admin: rooms[name].admin
  }));
}

//Reset ROOM
function resetRoom(room) {
  if (!room) return;

  if (room.lineTimer) {
    clearTimeout(room.lineTimer);
    room.lineTimer = null;
  }

  room.sceneStarted = false;
  room.currentLineIndex = 0;
  room.currentCharIndex = 0;
  room.karaokeStep = 2;
  room.baseDelay = 90;
  room.punctuationDelay = 300;
  room.sceneToken++;
  // room.scriptData = null;
  // room.script = null;
  // room.characterAssignments = {}; (optional depending on UX)
}

// ===== SOCKET =====
io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  socket.emit("welcome", { socketId: socket.id });

  // LOGIN SOCKET
  socket.on("login", ({ username }, cb) => {
    socket.data.username = username;

    activeUsers.set(socket.id, username);

    // ADD THIS
    socket.emit("rooms", roomList);

    socket.emit("scriptListFull", allScripts);
    io.emit("activeUsers", Array.from(activeUsers.values()));

    cb?.({ success: true });
  });

    // CREATE ROOM
  socket.on("createRoom", ({ roomName }) => {
    const username = socket.data.username;
    if (!username) return socket.emit("errorMessage", "Unauthorized");

    if (rooms[roomName])
      return socket.emit("errorMessage", "Room exists");

    if (Object.values(rooms).some(r => r.admin === username))
      return socket.emit("errorMessage", "Already own room");

    rooms[roomName] = {
      admin: username,
      members: {},
      sceneToken: 0,
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

    // CRITICAL FIX: auto join creator
    rooms[roomName].members[socket.id] = username;
    socket.join(roomName);

    updateRoomList();
    io.emit("rooms", roomList);

    io.to(roomName).emit("roomState", {
      users: Object.values(rooms[roomName].members),
      admin: username,
    });
  });

  // DELETE ROOM (FIXED CLEANUP)
  socket.on("deleteRoom", ({ roomName }) => {
    const room = rooms[roomName];
    if (!room) return;

    if (room.admin !== socket.data.username)
      return socket.emit("errorMessage", "Not admin");

    resetRoom(room);
    delete rooms[roomName];

    updateRoomList();
    io.emit("rooms", roomList);
  });

  // JOIN ROOM
  socket.on("joinRoom", ({ room, username }) => {
    const roomObj = rooms[room]; // ✅ define first

    if (!roomObj)
      return socket.emit("errorMessage", "Room not found");

    if (!socket.data.username)
      socket.data.username = username;

    roomObj.members[socket.id] = username;

    socket.join(room);

    io.to(room).emit("roomState", {
      users: Object.values(roomObj.members),
      admin: roomObj.admin,
    });

    socket.emit("scriptListFull", allScripts);
  });
  // LEAVE ROOM
  socket.on("leaveRoom", ({ room, username }) => {
    const roomObj = rooms[room];
    if (!roomObj) return;

    delete roomObj.members[socket.id];

    socket.leave(room);

    io.to(room).emit("roomState", {
      users: Object.values(roomObj.members),
      admin: roomObj.admin
    });
  });

  // SELECT SCRIPT (FIXED: NO socket.join)
  socket.on("selectScript", ({ room, scriptId }) => {
    const roomInfo = rooms[room];
    if (!roomInfo) return;

    if (roomInfo.script === scriptId) {
      resetRoom(roomInfo);

      io.to(room).emit("scriptSelected", {
        scriptId: null,
        scriptData: null,
        karaokeStep: 0,
        baseDelay: 0,
        punctuationDelay: 0,
        admin: roomInfo.admin,
      });

      return;
    }

    const scriptObj = allScripts.find(s => s.id === scriptId);
    if (!scriptObj) return;

    roomInfo.script = scriptId;
    roomInfo.scriptData = Object.freeze({ ...scriptObj });
    roomInfo.karaokeStep = scriptObj.karaokeStep ?? 2;
    roomInfo.baseDelay = scriptObj.baseDelay ?? 90;
    roomInfo.punctuationDelay = scriptObj.punctuationDelay ?? 300;

    io.to(room).emit("scriptSelected", {
      scriptId,
      scriptData: roomInfo.scriptData,
      karaokeStep: roomInfo.karaokeStep,
      baseDelay: roomInfo.baseDelay,
      punctuationDelay: roomInfo.punctuationDelay,
      admin: roomInfo.admin,
    });
  });

  // CHARACTER ASSIGNMENT
  socket.on("assignCharacter", ({ room, character, username }) => {
    const r = rooms[room];
    if (!r || r.characterAssignments[character]) return;

    r.characterAssignments[character] = username;
    io.to(room).emit("characterAssignments", r.characterAssignments);
  });

  socket.on("unselectCharacter", ({ room, character, username }) => {
    const r = rooms[room];
    if (!r) return;

    if (r.characterAssignments[character] === username) {
      delete r.characterAssignments[character];
      io.to(room).emit("characterAssignments", r.characterAssignments);
    }
  });

  // START SCENE (unchanged logic, safe)
  socket.on("startScene", ({ room }) => {
    const r = rooms[room];
    if (!r?.scriptData) return;

    // already running check (separate from token system)
    if (r.sceneStarted)
      return socket.emit("errorMessage", "Already running");

    // NEW RUN ID
    r.sceneToken++;
    const token = r.sceneToken;

    r.sceneStarted = true;
    r.currentLineIndex = 0;
    r.currentCharIndex = 0;

    io.to(room).emit("sceneStarted", {
      scriptData: r.scriptData,
      characterAssignments: r.characterAssignments,
    });

    function advance() {
      if (!r.sceneStarted || token !== r.sceneToken) return;

      const line = r.scriptData.lines[r.currentLineIndex];
      if (!line) return;

      let step = 1;
      let delay = r.baseDelay;

      for (let i = 0; i < r.karaokeStep; i++) {
        const ch = line.text[r.currentCharIndex + i];
        if (!ch) break;

        step = i + 1;
        if (/[.,!?]/.test(ch)) {
          delay = r.punctuationDelay;
          break;
        }
      }

      r.currentCharIndex += step;

      io.to(room).emit("lineProgress", {
        currentLineIndex: r.currentLineIndex,
        currentCharIndex: r.currentCharIndex,
      });

      if (r.currentCharIndex >= line.text.length) {
        r.currentLineIndex++;
        r.currentCharIndex = 0;

        if (r.currentLineIndex >= r.scriptData.lines.length) {
          r.sceneStarted = false;
          io.to(room).emit("sceneFinished");
          return;
        }
      }

      r.lineTimer = setTimeout(advance, delay);
    }

    advance();
  });

  socket.on("stopScene", ({ room }) => {
    const r = rooms[room];
    if (!r) return;

    if (r.lineTimer) clearTimeout(r.lineTimer);
    resetRoom(r);

    io.to(room).emit("sceneStopped");
  });

  socket.on("endScene", ({ room }) => {
    const r = rooms[room];
    if (!r) return;

    if (r.lineTimer) clearTimeout(r.lineTimer);
    resetRoom(r);

    io.to(room).emit("characterAssignments", {});
    io.to(room).emit("sceneStopped");
  });

  // DISCONNECT (FIXED CLEANUP)
  socket.on("disconnect", () => {
    const username = socket.data.username;

    if (username) {
      activeUsers.delete(socket.id); //

      for (const roomName in rooms) {
        const room = rooms[roomName];

        for (const id in room.members) {
          if (room.members[id] === username) {
            delete room.members[id];
          }
        }

        io.to(roomName).emit("roomState", {
          users: Object.values(room.members),
          admin: room.admin,
        });
      }

      io.emit("activeUsers", Array.from(activeUsers.values())); // OK
    }
  });
});

// ===== START =====
server.listen(PORT, "0.0.0.0", () => {
  console.log(`BitKaraoke running on ${PORT}`);
});