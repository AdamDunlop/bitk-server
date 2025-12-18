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

/* ----------------- GLOBAL STATE ----------------- */
let rooms = {};
let roomList = [];
let activeUsers = [];

/* ----------------- LOAD SCRIPTS ----------------- */
function loadAllScripts() {
  const scriptsDir = path.join(__dirname, "scripts");
  if (!fs.existsSync(scriptsDir)) return {};

  const scriptFiles = fs
    .readdirSync(scriptsDir)
    .filter((f) => f.endsWith(".json"));
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

/* ----------------- SOCKET CONNECTION ----------------- */
io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  /* ---------------- LOGIN ---------------- */
  socket.on("login", ({ username }) => {
    socket.data.username = username;

    if (!activeUsers.includes(username)) activeUsers.push(username);

    console.log("Login:", username, "ActiveUsers:", activeUsers);

    // Emit to all clients
    io.emit("activeUsers", activeUsers);

    // Existing emits
    socket.emit("rooms", roomList);
    socket.emit("scriptListFull", Object.values(SCRIPTS));
  });


  /* ---------------- CREATE ROOM ---------------- */
  socket.on("createRoom", ({ roomName }) => {
    if (!rooms[roomName]) {
      rooms[roomName] = {
        admin: socket.data.username,
        members: {},
        script: null,
        scriptData: null,
        characterAssignments: {},
        sceneStarted: false,
        currentLineIndex: 0,
        currentCharIndex: 0,
        karaokeStep: 3,
        baseDelay: 16,
        punctuationDelay: 220,
        lineTimer: null,
      };
    }
    roomList = Object.keys(rooms);
    io.emit("rooms", roomList);
    console.log("Room created:", roomName);
  });

  /* ---------------- DELETE ROOM ---------------- */
  socket.on("deleteRoom", ({ roomName }) => {
    if (!roomName || !rooms[roomName]) return;

    if (rooms[roomName].admin !== socket.data.username) {
      socket.emit("errorMessage", "Only the room admin can delete this room");
      return;
    }

    if (rooms[roomName].lineTimer) clearTimeout(rooms[roomName].lineTimer);

    delete rooms[roomName];
    roomList = Object.keys(rooms);
    io.emit("rooms", roomList);
    console.log("Room deleted:", roomName);
  });

  /* ---------------- JOIN ROOM ---------------- */
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
      io.to(room).emit(
        "characterAssignments",
        rooms[room].characterAssignments
      );
    }

    console.log(`${name} joined room ${room}`);
  });

  /* ---------------- SELECT SCRIPT ---------------- */
  socket.on("selectScript", ({ room, scriptName }) => {
    const roomInfo = rooms[room];
    if (!roomInfo || !SCRIPTS[scriptName]) return;

    roomInfo.script = scriptName;
    roomInfo.scriptData = SCRIPTS[scriptName];
    roomInfo.characterAssignments = {};
    roomInfo.sceneStarted = false;
    roomInfo.currentLineIndex = 0;
    roomInfo.currentCharIndex = 0;

    io.to(room).emit("scriptSelected", {
      scriptName,
      scriptData: roomInfo.scriptData,
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
      const line = roomInfo.scriptData.lines[roomInfo.currentLineIndex];
      if (!line) return;

      let step = 1;
      let delay = roomInfo.baseDelay;

      for (
        let i = 0;
        i < roomInfo.karaokeStep &&
        roomInfo.currentCharIndex + i < line.text.length;
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

  /* ---------------- DISCONNECT ---------------- */
  socket.on("disconnect", () => {
    const username = socket.data.username;

    // Remove from global activeUsers
    if (username) {
      const index = activeUsers.indexOf(username);
      if (index !== -1) activeUsers.splice(index, 1);
      io.emit("activeUsers", activeUsers);
    }

    // Remove from any rooms
    for (const room in rooms) {
      if (rooms[room].members[socket.id]) {
        delete rooms[room].members[socket.id];
        io.to(room).emit(
          "roomState",
          Object.values(rooms[room].members)
        );
      }
    }

    console.log("Socket disconnected:", socket.id);
  });
});

/* ---------------- START SERVER ---------------- */
server.listen(3000, () => {
  console.log("✅ Server running on port 3000");
});
