require('dotenv').config();
require('express-async-errors');

const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const Redis = require('ioredis');
const { v4: uuid } = require('uuid');
const { S3Client, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand, CreateBucketCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

const config = {
  port: Number(process.env.PORT || 4000),
  mongoUri: process.env.MONGODB_URI,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  bucket: process.env.S3_BUCKET,
  maxFileSize: Number(process.env.MAX_FILE_SIZE_MB || 150) * 1024 * 1024
};
if (!config.mongoUri || !config.jwtSecret || !config.bucket) throw new Error('MONGODB_URI, JWT_SECRET and S3_BUCKET are required');

const User = mongoose.model('User', new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true, minlength: 8, select: false }
}, { timestamps: true }));
const folderSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  parent: { type: mongoose.Schema.Types.ObjectId, ref: 'Folder', default: null, index: true },
  sharedWith: [{ user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, permission: { type: String, enum: ['view', 'edit'], default: 'view' } }]
}, { timestamps: true });
folderSchema.index({ owner: 1, parent: 1, name: 1 }, { unique: true });
const Folder = mongoose.model('Folder', folderSchema);
const File = mongoose.model('File', new mongoose.Schema({
  name: { type: String, required: true, trim: true }, originalName: String,
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  folder: { type: mongoose.Schema.Types.ObjectId, ref: 'Folder', default: null, index: true },
  s3Key: { type: String, required: true, unique: true }, mimeType: String, size: Number,
  publicToken: { type: String, unique: true, sparse: true },
  sharedWith: [{ user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, permission: { type: String, enum: ['view', 'edit'], default: 'view' } }]
}, { timestamps: true }));

const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 }) : null;
if (redis) { redis.on('error', () => { }); redis.connect().catch(() => { }); }
const cacheKey = (id) => `file-meta:${id}`;
const cacheGet = async (id) => { try { const item = await redis?.get(cacheKey(id)); return item && JSON.parse(item); } catch { return null; } };
const cacheSet = async (item) => { try { await redis?.set(cacheKey(item._id), JSON.stringify(item), 'EX', 300); } catch { } };
const cacheDrop = async (id) => { try { await redis?.del(cacheKey(id)); } catch { } };

const s3 = new S3Client({ region: process.env.S3_REGION || 'us-east-1', endpoint: process.env.S3_ENDPOINT || undefined, forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true' });
async function ensureBucket() { try { await s3.send(new HeadBucketCommand({ Bucket: config.bucket })); } catch { await s3.send(new CreateBucketCommand({ Bucket: config.bucket })); } }
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxFileSize, files: 1 } });
const app = express();
app.set('trust proxy', 1);
app.use(helmet()); app.use(cors({ origin: process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',') : true })); app.use(morgan('dev')); app.use(express.json());

const safeUser = (user) => ({ id: user._id, name: user.name, email: user.email });
const tokenFor = (user) => jwt.sign({ sub: user._id }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
async function auth(req, res, next) { const token = req.headers.authorization?.replace(/^Bearer\s+/i, ''); if (!token) return res.status(401).json({ message: 'Authentication required' }); try { req.user = await User.findById(jwt.verify(token, config.jwtSecret).sub); if (!req.user) throw new Error(); next(); } catch { res.status(401).json({ message: 'Invalid or expired token' }); } }
const isOwner = (resource, id) => resource.owner.toString() === id.toString();
const permission = (resource, id) => resource.sharedWith.find((x) => x.user.toString() === id.toString())?.permission;
function canRead(resource, id) { return isOwner(resource, id) || Boolean(permission(resource, id)); }
function canEdit(resource, id) { return isOwner(resource, id) || permission(resource, id) === 'edit'; }
async function findSharee(email) { const user = await User.findOne({ email: String(email).toLowerCase() }); if (!user) { const error = new Error('User not found'); error.status = 404; throw error; } return user; }
function serializeFile(file) { const item = file.toObject ? file.toObject() : file; delete item.s3Key; return item; }
async function nestedFolderIds(folderId) { const ids = [folderId.toString()]; let level = [folderId]; while (level.length) { const children = await Folder.find({ parent: { $in: level } }).select('_id'); level = children.map((child) => child._id); ids.push(...level.map((id) => id.toString())); } return ids; }
async function setFolderTreeAccess(folder, userId, sharePermission) { const ids = await nestedFolderIds(folder._id); const folders = await Folder.find({ _id: { $in: ids } }); const files = await File.find({ folder: { $in: ids } }); for (const resource of [...folders, ...files]) { resource.sharedWith = resource.sharedWith.filter((entry) => entry.user.toString() !== userId.toString()); if (sharePermission) resource.sharedWith.push({ user: userId, permission: sharePermission }); await resource.save(); if (resource.s3Key) await cacheDrop(resource._id); } }
function inheritedShares(parent) { const shares = parent.sharedWith.map((entry) => ({ user: entry.user, permission: entry.permission })); if (!shares.some((entry) => entry.user.toString() === parent.owner.toString())) shares.push({ user: parent.owner, permission: 'edit' }); return shares; }

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.post('/api/auth/register', async (req, res) => { const { name, email, password } = req.body; if (!name || !email || !password) return res.status(400).json({ message: 'name, email and password are required' }); if (await User.exists({ email: email.toLowerCase() })) return res.status(409).json({ message: 'Email already registered' }); const user = await User.create({ name, email, password: await bcrypt.hash(password, 12) }); res.status(201).json({ user: safeUser(user), token: tokenFor(user) }); });
app.post('/api/auth/login', async (req, res) => { const user = await User.findOne({ email: String(req.body.email || '').toLowerCase() }).select('+password'); if (!user || !(await bcrypt.compare(req.body.password || '', user.password))) return res.status(401).json({ message: 'Invalid email or password' }); res.json({ user: safeUser(user), token: tokenFor(user) }); });
app.get('/api/auth/me', auth, (req, res) => res.json({ user: safeUser(req.user) }));

app.post('/api/folders', auth, async (req, res) => { const { name, parent = null } = req.body; if (!name) return res.status(400).json({ message: 'Folder name is required' }); let parentFolder; if (parent) { parentFolder = await Folder.findById(parent); if (!parentFolder || !canEdit(parentFolder, req.user._id)) return res.status(403).json({ message: 'Cannot create in this folder' }); } const folder = await Folder.create({ name, parent, owner: parentFolder?.owner || req.user._id, sharedWith: parentFolder ? inheritedShares(parentFolder) : [] }); res.status(201).json(folder); });
app.get('/api/folders/:id/contents', auth, async (req, res) => { const folder = req.params.id === 'root' ? null : await Folder.findById(req.params.id); if (req.params.id !== 'root' && (!folder || !canRead(folder, req.user._id))) return res.status(404).json({ message: 'Folder not found' }); const folderId = folder?._id || null; const filter = { folder: folderId, $or: [{ owner: req.user._id }, { 'sharedWith.user': req.user._id }] }; const folders = await Folder.find({ parent: folderId, $or: [{ owner: req.user._id }, { 'sharedWith.user': req.user._id }] }).sort('name'); const files = await File.find(filter).sort('name'); res.json({ folders, files: files.map(serializeFile) }); });
app.patch('/api/folders/:id', auth, async (req, res) => { const folder = await Folder.findById(req.params.id); if (!folder || !canEdit(folder, req.user._id)) return res.status(404).json({ message: 'Folder not found' }); if (req.body.name) folder.name = req.body.name; if (Object.hasOwn(req.body, 'parent')) folder.parent = req.body.parent || null; await folder.save(); res.json(folder); });
app.post('/api/folders/:id/share', auth, async (req, res) => { const folder = await Folder.findById(req.params.id); if (!folder || !isOwner(folder, req.user._id)) return res.status(404).json({ message: 'Folder not found' }); const user = await findSharee(req.body.email); const sharePermission = req.body.permission === 'edit' ? 'edit' : 'view'; await setFolderTreeAccess(folder, user._id, sharePermission); res.json({ message: 'Folder and its contents shared' }); });
app.delete('/api/folders/:id/share', auth, async (req, res) => { const folder = await Folder.findById(req.params.id); if (!folder || !isOwner(folder, req.user._id)) return res.status(404).json({ message: 'Folder not found' }); const user = await findSharee(req.body.email); await setFolderTreeAccess(folder, user._id, null); res.status(204).end(); });
app.get('/api/shared', auth, async (req, res) => { const [folders, files] = await Promise.all([Folder.find({ owner: { $ne: req.user._id }, 'sharedWith.user': req.user._id }).sort('-updatedAt'), File.find({ owner: { $ne: req.user._id }, 'sharedWith.user': req.user._id }).sort('-updatedAt')]); res.json({ folders, files: files.map(serializeFile) }); });

app.post('/api/files/upload', auth, upload.single('file'), async (req, res) => { if (!req.file) return res.status(400).json({ message: 'Attach one file using the field name file' }); const folder = req.body.folder || null; let target; if (folder) { target = await Folder.findById(folder); if (!target || !canEdit(target, req.user._id)) return res.status(403).json({ message: 'Cannot upload to this folder' }); } const key = `${req.user._id}/${uuid()}-${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`; await new Upload({ client: s3, params: { Bucket: config.bucket, Key: key, Body: req.file.buffer, ContentType: req.file.mimetype }, partSize: 8 * 1024 * 1024, queueSize: 4 }).done(); const file = await File.create({ name: req.body.name || req.file.originalname, originalName: req.file.originalname, owner: target?.owner || req.user._id, folder, s3Key: key, mimeType: req.file.mimetype, size: req.file.size, sharedWith: target ? inheritedShares(target) : [] }); res.status(201).json(serializeFile(file)); });
app.get('/api/files/:id', auth, async (req, res) => { let file = await cacheGet(req.params.id); if (!file) { file = await File.findById(req.params.id); if (file) await cacheSet(file); } if (!file || !canRead(file, req.user._id)) return res.status(404).json({ message: 'File not found' }); res.json(serializeFile(file)); });
app.get('/api/files/:id/download', auth, async (req, res) => { const file = await File.findById(req.params.id); if (!file || !canRead(file, req.user._id)) return res.status(404).json({ message: 'File not found' }); const object = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: file.s3Key })); res.setHeader('Content-Type', file.mimeType || 'application/octet-stream'); res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.originalName)}"`); object.Body.pipe(res); });
app.get('/api/files/:id/preview', auth, async (req, res) => { const file = await File.findById(req.params.id); if (!file || !canRead(file, req.user._id)) return res.status(404).json({ message: 'File not found' }); const object = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: file.s3Key })); res.setHeader('Content-Type', file.mimeType || 'application/octet-stream'); res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.originalName)}"`); object.Body.pipe(res); });
app.patch('/api/files/:id', auth, async (req, res) => { const file = await File.findById(req.params.id); if (!file || !canEdit(file, req.user._id)) return res.status(404).json({ message: 'File not found' }); if (req.body.name) file.name = req.body.name; if (Object.hasOwn(req.body, 'folder')) file.folder = req.body.folder || null; await file.save(); await cacheDrop(file._id); res.json(serializeFile(file)); });
app.post('/api/files/:id/share', auth, async (req, res) => { const file = await File.findById(req.params.id); if (!file || !isOwner(file, req.user._id)) return res.status(404).json({ message: 'File not found' }); const user = await findSharee(req.body.email); file.sharedWith = file.sharedWith.filter((x) => x.user.toString() !== user._id.toString()); file.sharedWith.push({ user: user._id, permission: req.body.permission === 'edit' ? 'edit' : 'view' }); await file.save(); await cacheDrop(file._id); res.json({ message: 'File shared', file: serializeFile(file) }); });
app.delete('/api/files/:id/share', auth, async (req, res) => { const file = await File.findById(req.params.id); if (!file || !isOwner(file, req.user._id)) return res.status(404).json({ message: 'File not found' }); const user = await findSharee(req.body.email); file.sharedWith = file.sharedWith.filter((entry) => entry.user.toString() !== user._id.toString()); await file.save(); await cacheDrop(file._id); res.status(204).end(); });
app.post('/api/files/:id/public-link', auth, async (req, res) => { const file = await File.findById(req.params.id); if (!file || !isOwner(file, req.user._id)) return res.status(404).json({ message: 'File not found' }); if (!file.publicToken) { file.publicToken = uuid(); await file.save(); } const baseUrl = (process.env.PUBLIC_API_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, ''); res.json({ publicUrl: `${baseUrl}/api/public/${file.publicToken}` }); });
app.delete('/api/files/:id/public-link', auth, async (req, res) => { const file = await File.findById(req.params.id); if (!file || !isOwner(file, req.user._id)) return res.status(404).json({ message: 'File not found' }); file.publicToken = undefined; await file.save(); res.status(204).end(); });
app.delete('/api/files/:id', auth, async (req, res) => { const file = await File.findById(req.params.id); if (!file || !isOwner(file, req.user._id)) return res.status(404).json({ message: 'File not found' }); await s3.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: file.s3Key })); await file.deleteOne(); await cacheDrop(file._id); res.status(204).end(); });
app.get('/api/public/:token', async (req, res) => { const file = await File.findOne({ publicToken: req.params.token }); if (!file) return res.status(404).json({ message: 'This public link is unavailable' }); const object = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: file.s3Key })); res.setHeader('Content-Type', file.mimeType || 'application/octet-stream'); res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.originalName)}"`); object.Body.pipe(res); });
app.use((err, _req, res, _next) => { console.error(err); if (err instanceof multer.MulterError) return res.status(400).json({ message: err.message }); res.status(err.status || 500).json({ message: err.message || 'Unexpected server error' }); });

async function start() { await mongoose.connect(config.mongoUri); await ensureBucket(); app.listen(config.port, () => console.log(`API listening on http://localhost:${config.port}`)); }
if (require.main === module) start().catch((error) => { console.error(error); process.exit(1); });
module.exports = app;
