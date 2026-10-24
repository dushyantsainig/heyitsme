const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let waitingUser = null;

io.on('connection', (socket) => {
  socket.partner = null;

  socket.on('find_partner', () => {
    if (socket.partner) {
      socket.partner.emit('partner_disconnected');
      socket.partner.partner = null;
      socket.partner = null;
    }

    if (waitingUser && waitingUser.id !== socket.id) {
      socket.partner = waitingUser;
      waitingUser.partner = socket;

      socket.emit('chat_start', 'Aap ek stranger ke sath connect ho gaye!');
      waitingUser.emit('chat_start', 'Aap ek stranger ke sath connect ho gaye!');

      waitingUser = null;
    } else {
      waitingUser = socket;
      socket.emit('waiting', 'Stranger dhoonda ja raha hai...');
    }
  });

  socket.on('send_message', (msg) => {
    if (socket.partner) {
      socket.partner.emit('receive_message', msg);
    }
  });

  const handleLeave = () => {
    if (waitingUser && waitingUser.id === socket.id) {
      waitingUser = null;
    }
    if (socket.partner) {
      socket.partner.emit('partner_disconnected');
      socket.partner.partner = null;
      socket.partner = null;
    }
  };

  socket.on('disconnect', handleLeave);
  socket.on('leave_chat', handleLeave);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
