require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;

// Configure Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
    }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Store connected users and their private chats
const users = new Map();
const userSockets = new Map();
const privateChats = new Map();

// File upload endpoint
app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const buffer = req.file.buffer;
        const result = await new Promise((resolve, reject) => {
            cloudinary.uploader.upload_stream({
                resource_type: 'auto'
            }, (error, result) => {
                if (error) reject(error);
                else resolve(result);
            }).end(buffer);
        });

        res.json({ url: result.secure_url });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Upload failed' });
    }
});

io.on('connection', (socket) => {
    console.log('New client connected');

    socket.on('user_join', ({ username, avatar, profilePic }) => {
        const userData = { 
            username, 
            avatar: profilePic || avatar,
            socketId: socket.id 
        };
        users.set(socket.id, userData);
        userSockets.set(username, socket.id);
        io.emit('user_list', Array.from(users.values()));
        socket.broadcast.emit('user_connected', userData);
    });

    socket.on('start_private_chat', (targetUsername) => {
        const user = users.get(socket.id);
        const targetSocketId = userSockets.get(targetUsername);
        
        if (user && targetSocketId) {
            const chatId = [user.username, targetUsername].sort().join('_');
            if (!privateChats.has(chatId)) {
                privateChats.set(chatId, []);
            }
            
            socket.emit('private_chat_started', {
                chatId,
                username: targetUsername,
                messages: privateChats.get(chatId)
            });
        }
    });

    socket.on('send_message', (data) => {
        const user = users.get(socket.id);
        if (user) {
            const messageData = {
                message: data.message,
                username: user.username,
                avatar: user.avatar,
                timestamp: new Date().toISOString(),
                id: Math.random().toString(36).substr(2, 9),
                type: data.type || 'text',
                fileUrl: data.fileUrl
            };
            
            if (data.to) {
                // Private message
                const recipientSocket = userSockets.get(data.to);
                const chatId = [user.username, data.to].sort().join('_');
                
                if (privateChats.has(chatId)) {
                    privateChats.get(chatId).push(messageData);
                } else {
                    privateChats.set(chatId, [messageData]);
                }
                
                if (recipientSocket) {
                    io.to(recipientSocket).emit('private_message', {
                        ...messageData,
                        chatId
                    });
                    socket.emit('private_message', {
                        ...messageData,
                        chatId
                    });
                }
            } else {
                // Public message
                io.emit('new_message', messageData);
            }
        }
    });

    socket.on('typing', (data) => {
        const user = users.get(socket.id);
        if (user) {
            if (data.to) {
                const recipientSocket = userSockets.get(data.to);
                if (recipientSocket) {
                    io.to(recipientSocket).emit('user_typing', {
                        username: user.username,
                        isTyping: data.isTyping
                    });
                }
            } else {
                socket.broadcast.emit('user_typing', {
                    username: user.username,
                    isTyping: data.isTyping
                });
            }
        }
    });

    socket.on('disconnect', () => {
        const user = users.get(socket.id);
        if (user) {
            userSockets.delete(user.username);
            users.delete(socket.id);
            io.emit('user_list', Array.from(users.values()));
            io.emit('user_disconnected', user.username);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
