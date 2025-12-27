// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
// Define the base assets path
const ASSETS_PATH = path.join(__dirname, "assets");
const app = express();

app.use(cors());
app.use("/audio", express.static(path.join(ASSETS_PATH, "audio")));
// Serve image files
app.use("/images", express.static(path.join(ASSETS_PATH, "images")));
// Serve video files with correct Content-Type
app.use("/video", express.static(path.join(ASSETS_PATH, "video"), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".mp4")) {
      res.setHeader("Content-Type", "video/mp4");
    } else if (filePath.endsWith(".mov")) {
      res.setHeader("Content-Type", "video/quicktime");
    }
  },
}));

app.get("/", (req, res) => {
  res.send("BitKaraoke server is running. Use /images, /video, /audio paths.");
});

/* ----------------- CREATE SERVER ----------------- */
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

/* ----------------- GLOBAL STATE ----------------- */
let rooms = {}; // roomName => roomInfo
let roomList = []; // [{ name, admin }]
let activeUsers = [];

/* ----------------- LOAD SCRIPTS ----------------- */
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

/* ----------------- SOCKET CONNECTION ----------------- */
io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  /* ---------------- LOGIN ---------------- */
  socket.on("login", ({ username }) => {
    socket.data.username = username;

    if (!activeUsers.includes(username)) activeUsers.push(username);
    io.emit("activeUsers", activeUsers);

    socket.emit("rooms", roomList);
    socket.emit("scriptListFull", allScripts);
    console.log("Login:", username, "ActiveUsers:", activeUsers);
  });

  /* ---------------- CREATE ROOM ---------------- */
  socket.on("createRoom", ({ roomName }) => {
    if (!socket.data.username) {
      socket.emit("errorMessage", "Unauthorized");
      return;
    }

    // Check if room name already exists
    if (rooms[roomName]) {
      socket.emit("errorMessage", "Room name is already taken. Please choose a new name.");
      return;
    }

    // Check if user already has a room
    const userAlreadyHasRoom = Object.values(rooms).some(
      (room) => room.admin === socket.data.username
    );
    if (userAlreadyHasRoom) {
      socket.emit("errorMessage", "You already have a room.");
      return;
    }

    // Create the room
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


  /* ---------------- DELETE ROOM ---------------- */
  socket.on("deleteRoom", ({ roomName }) => {
    if (!roomName || !rooms[roomName]) return;

    if (!socket.data?.username) {
      socket.emit("errorMessage", "Unauthorized");
      return;
    }

    if (rooms[roomName].admin !== socket.data.username) {
      socket.emit("errorMessage", "Only the room admin can delete this room");
      return;
    }

    // Notify users & kick them out
    io.to(roomName).emit("roomDeleted", roomName);
    io.in(roomName).socketsLeave(roomName);

    if (rooms[roomName].lineTimer) clearTimeout(rooms[roomName].lineTimer);

    delete rooms[roomName];

    roomList = Object.keys(rooms).map((name) => ({
      name,
      admin: rooms[name].admin,
    }));

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

    socket.emit("scriptListFull", allScripts);

    if (rooms[room].script && rooms[room].scriptData) {
      socket.emit("scriptSelected", {
        scriptName: rooms[room].script,
        scriptData: rooms[room].scriptData,
        admin: rooms[room].admin,
      });
    }

    socket.emit("characterAssignments", rooms[room].characterAssignments);

    if (rooms[room].sceneStarted) {
      socket.emit("sceneStarted", {
        scriptData: rooms[room].scriptData,
        characterAssignments: rooms[room].characterAssignments,
        currentLineIndex: rooms[room].currentLineIndex,
        currentCharIndex: rooms[room].currentCharIndex,
      });
    }

    console.log(`${name} joined room ${room}`);
  });

  /* ---------------- SELECT SCRIPT ---------------- */
  socket.on("selectScript", ({ room, scriptId }) => {
    const roomInfo = rooms[room];
    if (!roomInfo) return;

    socket.join(room);

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

  /* ---------------- DISCONNECT ---------------- */
  socket.on("disconnect", () => {
    const username = socket.data.username;

    if (username) {
      const index = activeUsers.indexOf(username);
      if (index !== -1) activeUsers.splice(index, 1);
      io.emit("activeUsers", activeUsers);
    }

    for (const room in rooms) {
      if (rooms[room].members[socket.id]) {
        delete rooms[room].members[socket.id];
        io.to(room).emit("roomState", Object.values(rooms[room].members));
      }
    }
    console.log("Socket disconnected:", socket.id);
  });
});


/* ---------------- START SERVER ---------------- */
const PORT = 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
