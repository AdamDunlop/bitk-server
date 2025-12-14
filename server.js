// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

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
 *     characterAssignments: { character: username }
 *   }
 * }
 */
let rooms = {};
let roomList = [];

/**
 * Example script data
 * (Later this can come from files or DB)
 */
const SCRIPTS = {
  seinfeld: {
    characters: ["Jerry", "George", "Elaine", "Kramer"],
    lines: [
      { id: 1, character: "Jerry", text: "What's the deal with airline food?" },
      { id: 2, character: "George", text: "I was in the pool!" },
      { id: 3, character: "Elaine", text: "Get out!" },
      { id: 4, character: "Kramer", text: "Giddy up!" },
    ],
  },
  friends: {
    characters: ["Ross", "Rachel", "Chandler", "Monica"],
    lines: [
      { id: 1, character: "Ross", text: "We were on a break!" },
      { id: 2, character: "Rachel", text: "No, we were not!" },
      { id: 3, character: "Chandler", text: "Could I BE any more sarcastic?" },
      { id: 4, character: "Monica", text: "I know!" },
    ],
  },
};

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  /* ---------------- LOGIN ---------------- */
  socket.on("login", ({ username }) => {
    socket.data.username = username;
    socket.emit("rooms", roomList);
    socket.emit("availableScripts", Object.keys(SCRIPTS));
    console.log("Login:", username);
  });

  /* ---------------- CREATE ROOM ---------------- */
  socket.on("createRoom", ({ roomName }) => {
    if (!roomName || rooms[roomName]) return;

    rooms[roomName] = {
      admin: socket.data.username,
      members: {},
      script: null,
      scriptData: null,
      characterAssignments: {},
    };

    roomList.push(roomName);
    io.emit("rooms", roomList);

    console.log("Room created:", roomName);
  });

  /* ---------------- JOIN ROOM ---------------- */
  socket.on("joinRoom", ({ username, room }) => {
    if (!room || !rooms[room]) return;

    const name = username || socket.data.username || "Unknown";

    
    rooms[room].members[socket.id] = name;
    socket.join(room);


    io.to(room).emit('roomState', {
      users: Object.values(rooms[room].members),
      admin: rooms[room].admin,
      script: rooms[room].script || null,
    });

    // notify others
    socket.to(room).emit("userJoinedRoom", { username: name });
    socket.emit("availableScripts", Object.keys(SCRIPTS));


    // send script state if exists
    if (rooms[room].script) {
      socket.emit("scriptSelected", {
        scriptName: rooms[room].script,
        scriptData: rooms[room].scriptData,
        admin: rooms[room].admin,
      });

      socket.emit(
        "characterAssignments",
        rooms[room].characterAssignments
      );
    }

    console.log(`${name} joined room ${room}`);
  });
  
  socket.on('deleteRoom', ({ roomName }) => {
    delete rooms[roomName];
    roomList = Object.keys(rooms);
    io.emit('rooms', roomList);
  });


  /* ---------------- LEAVE ROOM ---------------- */
  socket.on("leaveRoom", ({ room }) => {
    if (!rooms[room]) return;

    const username = rooms[room].members[socket.id];
    delete rooms[room].members[socket.id];

    socket.leave(room);

    io.to(room).emit(
      "roomUsers",
      Object.values(rooms[room].members)
    );

    if (username) {
      socket.to(room).emit("userLeft", username);
    }
  });

  /* ---------------- SELECT SCRIPT (ADMIN) ---------------- */
  socket.on("selectScript", ({ room, scriptName, scriptData }) => {
    rooms[room].script = scriptName;
    rooms[room].scriptData = scriptData;
    io.to(room).emit("scriptSelected", {
      scriptName,
      scriptData,
      admin: rooms[room].admin,
    });
  });

  /* ---------------- SELECT CHARACTER ---------------- */
  socket.on("selectCharacter", ({ room, character, username }) => {
    rooms[room].characterAssignments[character] = username;
    io.to(room).emit("characterAssigned", { character, username });
  });

  /* ---------------- UNSELECT CHARACTER ---------------- */
  socket.on("unselectCharacter", ({ room, character, username }) => {
    if (
      rooms[room]?.characterAssignments[character] === username
    ) {
      delete rooms[room].characterAssignments[character];
      io.to(room).emit(
        "characterAssignments",
        rooms[room].characterAssignments
      );
    }
  });
  socket.on("availableScripts", (scripts) => {
    setAvailableScripts(scripts);
  });

  socket.on("scriptSelected", ({ scriptName, scriptData, admin }) => {
    setSelectedScriptName(scriptName);
    setScriptData(scriptData);
    setIsAdmin(admin === username);
  });

  /* ---------------- DISCONNECT ---------------- */
  socket.on("disconnect", () => {
    for (const room in rooms) {
      if (rooms[room].members[socket.id]) {
        const username = rooms[room].members[socket.id];
        delete rooms[room].members[socket.id];

        io.to(room).emit(
          "roomUsers",
          Object.values(rooms[room].members)
        );

        socket.to(room).emit("userLeft", username);
      }
    }
    console.log("Socket disconnected:", socket.id);
  });
});

server.listen(3000, () => {
  console.log("✅ Server running on port 3000");
});
