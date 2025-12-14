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
 *     characterAssignments: { character: username },
 *     sceneStarted: boolean
 *   }
 * }
 */
let rooms = {};
let roomList = [];

/**
 * Example script data
 */
const SCRIPTS = {
  seinfeld_opposite: {
    characters: ["Jerry", "George", "Elaine", "Waitress", "Victoria"],
    lines: [
      { id: 1, character: "Jerry", text: "Speaking of having it all... Where were you?" },
      { id: 2, character: "George", text: "I went to the, the beach." },
      { id: 3, character: "George", text: "It's not working, Jerry. It's just not working." },
      { id: 4, character: "Jerry", text: "What is it that isn't working?" },
      { id: 5, character: "George", text: "Why did it all turn out like this for me? I had so much promise. I was personable, I was bright. Oh, maybe not academically speaking, but ... I was perceptive. I always know when someone's uncomfortable at a party. It became very clear to me sitting out there today, that every decision I've ever made, in my entire life, has been wrong. My life is the opposite of everything I want it to be. Every instinct I have, in every of life, be it something to wear, something to eat ... It's all been wrong." },
      { id: 6, character: "Waitress", text: "Tuna on toast, coleslaw, cup of coffee." },
      { id: 7, character: "George", text: "Yeah. No, no, no, wait a minute, I always have tuna on toast. Nothing's ever worked out for me with tuna on toast. I want the complete opposite of on toast. Chicken salad, on rye, untoasted ... and a cup of tea." },
      { id: 8, character: "Elaine", text: "Well, there's no telling what can happen from this." },
      { id: 9, character: "Jerry", text: "You know chicken salad is not the opposite of tuna, salmon is the opposite of tuna, 'cos salmon swim against the current, and the tuna swim with it." },
      { id: 10, character: "George",  text: "Good for the tuna.(Sarcasticly)" },
      { id: 11, character: "Victoria", text: "Oh, yes I was, you just ordered the same exact lunch as me." },
      { id: 1, character: "George", text: "My name is George. I'm unemployed and I live with my parents." }
    ]
  },
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
    socket.emit("scriptList", Object.keys(SCRIPTS)); // send scripts to client
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

    // emit only room state
    io.to(room).emit("roomState", {
      users: Object.values(rooms[room].members),
      admin: rooms[room].admin,
    });

    // send available scripts
    socket.emit("scriptList", Object.keys(SCRIPTS));

    // send script state if already selected
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

    // notify others
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

    // Remove any character assignments held by this user
    for (const character in rooms[room].characterAssignments) {
      if (rooms[room].characterAssignments[character] === username) {
        delete rooms[room].characterAssignments[character];
      }
    }

    // Emit updated state
    io.to(room).emit(
      "roomUsers",
      Object.values(rooms[room].members)
    );
    io.to(room).emit(
      "characterAssignments",
      rooms[room].characterAssignments
    );

    if (username) {
      socket.to(room).emit("userLeft", username);
    }
  });


  /* ---------------- SELECT SCRIPT (ADMIN) ---------------- */
  socket.on("selectScript", ({ room, scriptName }) => {
    const roomInfo = rooms[room];
    if (!roomInfo) return;

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

  /* ---------------- SELECT CHARACTER ---------------- */
  socket.on("assignCharacter", ({ room, character, username }) => {
    const roomInfo = rooms[room];
    if (!roomInfo) return;

    // Prevent stealing characters
    if (roomInfo.characterAssignments[character]) return;

    roomInfo.characterAssignments[character] = username;

    io.to(room).emit(
      "characterAssignments",
      roomInfo.characterAssignments
    );
  });

  /* ---------------- UNSELECT CHARACTER ---------------- */
  socket.on("unselectCharacter", ({ room, character, username }) => {
    const roomInfo = rooms[room];
    if (!roomInfo) return;

    if (roomInfo.characterAssignments[character] === username) {
      delete roomInfo.characterAssignments[character];
      io.to(room).emit(
        "characterAssignments",
        roomInfo.characterAssignments
      );
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

    io.to(room).emit("sceneStarted", {
      scriptData: roomInfo.scriptData,
      characterAssignments: roomInfo.characterAssignments,
    });
  });

  /* ---------------- DISCONNECT ---------------- */
  socket.on("disconnect", () => {
    for (const room in rooms) {
      if (!rooms[room].members) continue;

      if (rooms[room].members[socket.id]) {
        const username = rooms[room].members[socket.id];
        delete rooms[room].members[socket.id];

        io.to(room).emit(
          "roomState",
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
