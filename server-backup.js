// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

// ----------------- ROOMS -----------------
let rooms = {};
let roomList = [];

// ----------------- LOAD SCRIPTS -----------------
function loadAllScripts() {
  const scriptsDir = path.join(__dirname, "scripts");
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

let SCRIPTS = loadAllScripts();

// ----------------- SOCKET CONNECTION -----------------
io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  // ---------------- LOGIN ----------------
  socket.on("login", ({ username }) => {
    socket.data.username = username;
    socket.emit("rooms", roomList);
    socket.emit("scriptListFull", Object.values(SCRIPTS));
  });

  // ---------------- CREATE ROOM ----------------
  socket.on("createRoom", ({ roomName }) => {
    if (!rooms[roomName]) {
      rooms[roomName] = {
        admin: socket.data.username,
        members: {},
        script: null,
        scriptData: null,
        characterAssignments: {},
        sceneStarted: false,
      };
    }
    roomList = Object.keys(rooms);
    io.emit("rooms", roomList);
  });

  // ---------------- JOIN ROOM ----------------
  socket.on("joinRoom", ({ username, room }) => {
    if (!room || !rooms[room]) return;
    const name = username || socket.data.username || "Unknown";
    rooms[room].members[socket.id] = name;
    socket.join(room);

    io.to(room).emit("roomState", {
      users: Object.values(rooms[room].members),
      admin: rooms[room].admin,
    });

    socket.emit("scriptListFull", Object.values(SCRIPTS));

    if (rooms[room].script) {
      socket.emit("scriptSelected", {
        scriptName: rooms[room].script,
        scriptData: rooms[room].scriptData,
        admin: rooms[room].admin,
      });
      io.to(room).emit("characterAssignments", rooms[room].characterAssignments);
    }
  });

  // ---------------- SELECT SCRIPT ----------------
  socket.on("selectScript", ({ room, scriptName }) => {
    const roomInfo = rooms[room];
    if (!roomInfo || !SCRIPTS[scriptName]) return;

    roomInfo.script = scriptName;
    roomInfo.scriptData = SCRIPTS[scriptName];
    roomInfo.characterAssignments = {};
    roomInfo.sceneStarted = false;

    io.to(room).emit("scriptSelected", {
      scriptName,
      scriptData: roomInfo.scriptData,
      admin: roomInfo.admin,
    });
  });

  // ---------------- CHARACTER ASSIGNMENT ----------------
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

  // ---------------- START SCENE ----------------
  socket.on("startScene", ({ room }) => {
    const roomInfo = rooms[room];
    if (!roomInfo || !roomInfo.scriptData) return;

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

    // Start the server-driven character playback
    playScene(room);
  });

  // ---------------- SERVER-DRIVEN PLAYBACK ----------------
  const BASE_DELAY = 16;
  const PUNCTUATION_DELAY = 220;

  function playScene(room) {
    const roomInfo = rooms[room];
    if (!roomInfo || !roomInfo.sceneStarted) return;

    const script = roomInfo.scriptData;
    if (!script || !script.lines.length) return;

    const lineIndex = roomInfo.currentLineIndex;
    const line = script.lines[lineIndex];
    if (!line) return;

    // Initialize charIndex if not set
    if (roomInfo.currentCharIndex == null) roomInfo.currentCharIndex = 0;

    if (roomInfo.currentCharIndex < line.text.length) {
      const char = line.text[roomInfo.currentCharIndex];
      const delay = /[.,!?]/.test(char) ? PUNCTUATION_DELAY : BASE_DELAY;

      roomInfo.currentCharIndex += 1;

      io.to(room).emit("currentCharUpdate", {
        currentLineIndex: lineIndex,
        currentCharIndex: roomInfo.currentCharIndex,
      });

      setTimeout(() => playScene(room), delay);
    } else {
      // Move to next line
      if (roomInfo.currentLineIndex < script.lines.length - 1) {
        roomInfo.currentLineIndex += 1;
        roomInfo.currentCharIndex = 0;

        io.to(room).emit("currentLineUpdate", {
          currentLineIndex: roomInfo.currentLineIndex,
        });

        setTimeout(() => playScene(room), BASE_DELAY); // small buffer before next line
      } else {
        // Scene finished
        roomInfo.sceneStarted = false;
        io.to(room).emit("sceneFinished");
      }
    }
  }

  // ---------------- DISCONNECT ----------------
  socket.on("disconnect", () => {
    for (const room in rooms) {
      if (!rooms[room].members) continue;
      if (rooms[room].members[socket.id]) {
        const username = rooms[room].members[socket.id];
        delete rooms[room].members[socket.id];
        io.to(room).emit("roomState", Object.values(rooms[room].members));
        socket.to(room).emit("userLeft", username);
      }
    }
  });
});

// ----------------- SERVER START -----------------
server.listen(3000, () => {
  console.log("✅ Server running on port 3000");
});
