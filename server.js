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

/**
 * Rooms structure
 * rooms = {
 *   roomName: {
 *     admin: username,
 *     members: { socketId: username },
 *     script: null | scriptName,
 *     scriptData: null | { characters: [], lines: [] },
 *     characterAssignments: { character: username },
 *     sceneStarted: boolean
 *   }
 * }
 */
let rooms = {};
let roomList = [];

/**
 * ---------------- LOAD SCRIPTS FROM JSON ----------------
 */
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

/**
 * Optional: get scripts filtered by type
 */
function getScriptsByType(type) {
  return Object.values(SCRIPTS).filter((script) => script.type === type);
}

/**
 * ---------------- SOCKET CONNECTION ----------------
 */
io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  /* ---------------- LOGIN ---------------- */
  socket.on("login", ({ username }) => {
    socket.data.username = username;
    socket.emit("rooms", roomList);

    // send full script objects for client filtering
    socket.emit("scriptListFull", Object.values(SCRIPTS));

    console.log("Login:", username);
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
      };
    }
    roomList = Object.keys(rooms);
    io.emit("rooms", roomList);
    console.log("Room created:", roomName);
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

    // send full scripts for filtering
    socket.emit("scriptListFull", Object.values(SCRIPTS));

    if (rooms[room].script) {
      socket.emit("scriptSelected", {
        scriptName: rooms[room].script,
        scriptData: rooms[room].scriptData,
        admin: rooms[room].admin,
      });
      io.to(room).emit("characterAssignments", rooms[room].characterAssignments);
    }

    socket.to(room).emit("userJoinedRoom", { username: name });
    console.log(`${name} joined room ${room}`);
  });

  /* ---------------- DELETE ROOM ---------------- */
  socket.on("deleteRoom", ({ roomName }) => {
    delete rooms[roomName];
    roomList = Object.keys(rooms);
    io.emit("rooms", roomList);
  });

  /* ---------------- LEAVE ROOM ---------------- */
  socket.on("leaveRoom", ({ room }) => {
    if (!rooms[room]) return;
    const username = rooms[room].members[socket.id];
    delete rooms[room].members[socket.id];
    socket.leave(room);

    for (const character in rooms[room].characterAssignments) {
      if (rooms[room].characterAssignments[character] === username) {
        delete rooms[room].characterAssignments[character];
      }
    }

    io.to(room).emit("roomUsers", Object.values(rooms[room].members));
    io.to(room).emit("characterAssignments", rooms[room].characterAssignments);

    if (username) socket.to(room).emit("userLeft", username);
  });

  /* ---------------- SELECT SCRIPT ---------------- */
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

    io.to(room).emit("sceneStarted", {
      scriptData: roomInfo.scriptData,
      characterAssignments: roomInfo.characterAssignments,
      currentLineIndex: roomInfo.currentLineIndex,
    });
  });

  /* ---------------- ADVANCE LINE ---------------- */
  socket.on("advanceLine", ({ room }) => {
    const roomInfo = rooms[room];
    if (!roomInfo || !roomInfo.sceneStarted) return;

    if (roomInfo.currentLineIndex < roomInfo.scriptData.lines.length - 1) {
      roomInfo.currentLineIndex += 1;
      io.to(room).emit("currentLineUpdate", {
        currentLineIndex: roomInfo.currentLineIndex,
      });
    } else {
      // Instead of auto-reset:
      io.to(room).emit("sceneFinished"); // <- new event
    }
  });

  /* ---------------- DISCONNECT ---------------- */
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
    console.log("Socket disconnected:", socket.id);
  });
});

server.listen(3000, () => {
  console.log("✅ Server running on port 3000");
});
