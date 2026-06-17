import { io } from "socket.io-client";

const socket = io("http://10.0.0.77:3001", {
  transports: ["websocket"],
  reconnection: true,
});

export default socket;