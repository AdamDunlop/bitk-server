import { io } from "socket.io-client";

const socket = io("http://192.168.1.96:3001", {
  transports: ["websocket"],
  reconnection: true,
});

export default socket;