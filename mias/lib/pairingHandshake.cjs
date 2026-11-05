"use strict";

function socketIsOpen(socket) {
  return socket?.ws?.isOpen === true
    || socket?.ws?.readyState === 1
    || socket?.ws?.socket?.readyState === 1;
}

function socketIsClosed(socket) {
  return socket?.__retired === true
    || socket?.ws?.isClosed === true
    || socket?.ws?.isClosing === true
    || socket?.ws?.readyState === 3
    || socket?.ws?.socket?.readyState === 3;
}

function waitForSocketOpen(socket, timeoutMs = 35000) {
  return new Promise((resolve) => {
    let timer;
    let poll;
    let settled = false;
    const done = (open) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      try { socket.ev.off("connection.update", onUpdate); } catch {}
      try { socket.ev.removeListener("connection.update", onUpdate); } catch {}
      resolve(open);
    };
    const onUpdate = (update = {}) => {
      if (update.connection === "close" || socketIsClosed(socket)) done(false);
      else if (update.connection === "open" || socketIsOpen(socket)) done(true);
    };
    const check = () => {
      if (socketIsClosed(socket)) done(false);
      else if (socketIsOpen(socket)) done(true);
    };
    try { socket.ev.on("connection.update", onUpdate); } catch {}
    timer = setTimeout(() => done(false), timeoutMs);
    poll = setInterval(check, 250);
    check();
  });
}

function waitForPairingReady(socket, timeoutMs = 35000) {
  return new Promise((resolve) => {
    let timer;
    let poll;
    let settled = false;
    const done = (ready) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      try { socket.ev.off("connection.update", onUpdate); } catch {}
      try { socket.ev.removeListener("connection.update", onUpdate); } catch {}
      resolve(ready);
    };
    const check = () => {
      if (socketIsClosed(socket)) done(false);
      else if (socket.__pairingReady && socketIsOpen(socket)) done(true);
    };
    const onUpdate = (update = {}) => {
      if (update.connection === "close") {
        done(false);
        return;
      }
      if (update.qr) socket.__pairingReady = true;
      check();
    };
    try { socket.ev.on("connection.update", onUpdate); } catch {}
    timer = setTimeout(() => done(false), timeoutMs);
    poll = setInterval(check, 250);
    check();
  });
}

module.exports = { socketIsOpen, waitForSocketOpen, waitForPairingReady };
