const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');

const app = express();

app.use(cors());
app.use(express.json());

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    // Accept audio and video files
    const allowedTypes = /audio|video/;
    const mimeType = allowedTypes.test(file.mimetype);

    // Check common audio/video extensions
    const allowedExtensions = ['.mp3', '.wav', '.flac', '.m4a', '.ogg', '.wma', '.mp4', '.avi', '.mov', '.mkv', '.webm'];
    const fileExtension = path.extname(file.originalname).toLowerCase();
    const extname = allowedExtensions.includes(fileExtension);

    console.log(`File upload attempt: ${file.originalname}, MIME: ${file.mimetype}, Extension: ${fileExtension}`);

    if (mimeType || extname) {
      return cb(null, true);
    } else {
      console.error(`Rejected file: ${file.originalname} (MIME: ${file.mimetype}, Extension: ${fileExtension})`);
      cb(new Error('Only audio and video files are allowed!'));
    }
  },
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit
  }
});

// In-memory storage for conversion jobs (use Redis in production)
const conversionJobs = new Map();

// Helper function to perform actual audio/video conversion using FFmpeg
function convertFile(inputPath, outputPath, options = {}) {
  return new Promise((resolve, reject) => {
    const { format = 'mp3', bitrate, startTime, endTime, quality = 'high', fileId } = options;

    let ffmpegCommand = ffmpeg(inputPath);

    // Set audio codec and quality based on format
    if (format === 'mp3') {
      ffmpegCommand = ffmpegCommand
        .audioCodec('libmp3lame')
        .audioQuality(quality === 'high' ? 0 : quality === 'medium' ? 4 : 9);

      if (bitrate) {
        ffmpegCommand = ffmpegCommand.audioBitrate(bitrate);
      }
    } else if (format === 'wav') {
      ffmpegCommand = ffmpegCommand
        .audioCodec('pcm_s16le')
        .audioChannels(2)
        .audioFrequency(44100);
    } else if (format === 'flac') {
      ffmpegCommand = ffmpegCommand.audioCodec('flac');
    } else if (format === 'm4a') {
      ffmpegCommand = ffmpegCommand.audioCodec('aac');
    }

    // Add trimming if specified
    if (startTime !== undefined) {
      ffmpegCommand = ffmpegCommand.seekInput(startTime);
    }
    if (endTime !== undefined && startTime !== undefined) {
      ffmpegCommand = ffmpegCommand.duration(endTime - startTime);
    }

    // Extract audio only (no video)
    ffmpegCommand = ffmpegCommand
      .noVideo()
      .format(format)
      .output(outputPath)
      .on('start', (commandLine) => {
        console.log('FFmpeg process started:', commandLine);
      })
      .on('progress', (progress) => {
        console.log('Processing: ' + progress.percent + '% done');
        // Update progress in real-time if fileId is provided
        if (fileId && progress.percent) {
          const currentProgress = Math.min(50 + (progress.percent * 0.4), 95);
          const job = conversionJobs.get(fileId);
          if (job) {
            conversionJobs.set(fileId, { ...job, progress: Math.round(currentProgress) });
          }
        }
      })
      .on('end', () => {
        console.log('FFmpeg conversion completed successfully');
        resolve();
      })
      .on('error', (err) => {
        console.error('FFmpeg conversion error:', err);
        reject(err);
      });

    ffmpegCommand.run();
  });
}

// File upload endpoint
app.post('/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const fileId = uuidv4();
    const fileInfo = {
      id: fileId,
      originalName: req.file.originalname,
      filename: req.file.filename,
      path: req.file.path,
      size: req.file.size,
      mimetype: req.file.mimetype,
      uploadedAt: new Date().toISOString(),
      userId: req.body.userId || 'anonymous'
    };

    // Store file info (use database in production)
    conversionJobs.set(fileId, {
      ...fileInfo,
      status: 'uploaded'
    });

    res.json({
      fileId,
      message: 'File uploaded successfully',
      originalName: req.file.originalname,
      size: req.file.size
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Start conversion with optional trimming
app.post('/convert/:fileId', async (req, res) => {
  try {
    const { fileId } = req.params;
    const { format = 'mp3', quality = 'high', bitrate, startTime, endTime, trim = false } = req.body;

    const job = conversionJobs.get(fileId);
    if (!job) {
      return res.status(404).json({ error: 'File not found' });
    }

    const conversionId = uuidv4();
    const baseName = path.parse(job.originalName).name;
    const outputFilename = trim ? `${baseName}_trimmed.${format}` : `${baseName}.${format}`;

    // Create output directory
    const outputDir = path.join(__dirname, 'output');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const outputPath = path.join(outputDir, `${conversionId}-${outputFilename}`);

    // Start async conversion process
    setImmediate(async () => {
      try {
        // Update job as processing
        conversionJobs.set(fileId, {
          ...job,
          status: 'processing',
          conversionId,
          format,
          quality,
          bitrate,
          startTime: trim ? startTime : undefined,
          endTime: trim ? endTime : undefined,
          trim,
          outputPath,
          outputFilename,
          startedAt: new Date().toISOString(),
          progress: 20
        });

        // Update progress to indicate conversion is starting
        conversionJobs.set(fileId, { ...conversionJobs.get(fileId), progress: 30 });

        const conversionOptions = {
          format,
          quality,
          bitrate,
          startTime: trim ? startTime : undefined,
          endTime: trim ? endTime : undefined,
          fileId // Pass fileId for progress updates
        };

        if (trim && (startTime !== undefined && endTime !== undefined)) {
          console.log(`Trimming and converting audio from ${startTime}s to ${endTime}s to ${format}`);
        } else {
          console.log(`Converting to ${format} format`);
        }

        // Update progress
        conversionJobs.set(fileId, { ...conversionJobs.get(fileId), progress: 50 });

        // Perform actual conversion using FFmpeg
        await convertFile(job.path, outputPath, conversionOptions);

        console.log(`Audio successfully converted and saved to: ${outputPath}`);

        // Mark as completed
        conversionJobs.set(fileId, {
          ...conversionJobs.get(fileId),
          status: 'completed',
          completedAt: new Date().toISOString(),
          progress: 100
        });

      } catch (conversionError) {
        console.error('Conversion process failed:', conversionError);
        conversionJobs.set(fileId, {
          ...conversionJobs.get(fileId),
          status: 'failed',
          error: conversionError.message,
          completedAt: new Date().toISOString()
        });
      }
    });

    res.json({
      conversionId,
      message: trim ? 'Audio trimming started' : 'Conversion started',
      format,
      quality,
      trim: trim,
      startTime: trim ? startTime : undefined,
      endTime: trim ? endTime : undefined
    });

  } catch (error) {
    console.error('Conversion error:', error);
    res.status(500).json({ error: 'Conversion failed' });
  }
});

// Get conversion status
app.get('/status/:conversionId', (req, res) => {
  try {
    const { conversionId } = req.params;

    // Find job by conversionId
    let job = null;
    for (const [fileId, jobData] of conversionJobs.entries()) {
      if (jobData.conversionId === conversionId) {
        job = jobData;
        break;
      }
    }

    if (!job) {
      return res.status(404).json({ error: 'Conversion job not found' });
    }

    res.json({
      conversionId,
      status: job.status,
      progress: job.progress || 100,
      originalName: job.originalName,
      outputFilename: job.outputFilename,
      format: job.format,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      error: job.error
    });
  } catch (error) {
    console.error('Status check error:', error);
    res.status(500).json({ error: 'Failed to get status' });
  }
});

// Download converted file
app.get('/download/:conversionId', (req, res) => {
  try {
    const { conversionId } = req.params;

    // Find job by conversionId
    let job = null;
    for (const [fileId, jobData] of conversionJobs.entries()) {
      if (jobData.conversionId === conversionId) {
        job = jobData;
        break;
      }
    }

    if (!job) {
      return res.status(404).json({ error: 'Conversion job not found' });
    }

    if (job.status !== 'completed') {
      return res.status(400).json({ error: 'Conversion not completed' });
    }

    if (!fs.existsSync(job.outputPath)) {
      return res.status(404).json({ error: 'Converted file not found' });
    }

    res.setHeader('Content-Disposition', `attachment; filename="${job.outputFilename}"`);
    res.setHeader('Content-Type', 'application/octet-stream');

    const fileStream = fs.createReadStream(job.outputPath);
    fileStream.pipe(res);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: 'Download failed' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'converter' });
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`Converter service running on port ${PORT}`);
});