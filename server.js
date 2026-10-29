const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Upload directory ensure karein
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

// Multer Storage Configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        // Unique filename banane ke liye timestamp aur random number
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, file.fieldname + '-' + uniqueSuffix + ext);
    }
});

// File filter: Sirf video files allow karne ke liye
const fileFilter = (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) {
        cb(null, true);
    } else {
        cb(new Error('Sirf video files allow hain! (mp4, mkv, webm, etc.)'), false);
    }
};

// Upload setup (max 100MB limit set ki hai, ise change kar sakte hain)
const upload = multer({
    storage: storage,
    limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
    fileFilter: fileFilter
});

// Static files serve karne ke liye
app.use(express.static('public'));
app.use('/uploads', express.static(uploadDir));

// Video Upload Route
app.post('/api/upload-video', upload.single('videoFile'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'Koi file select nahi ki gayi.' });
    }

    const videoUrl = `/uploads/${req.file.filename}`;
    res.json({
        success: true,
        message: 'Video successfully upload ho gayi!',
        filename: req.file.filename,
        url: videoUrl
    });
}, (error, req, res, next) => {
    // Multer errors ya invalid file type handle karne ke liye
    res.status(400).json({ success: false, message: error.message });
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
