import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { MongoClient, ServerApiVersion, ObjectId } from 'mongodb';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const sessionStore = new Map();
const AUTH_SERVER_URL = process.env.AUTH_SERVER_URL || 'http://localhost:3000';
const JWKS = createRemoteJWKSet(new URL(`${AUTH_SERVER_URL}/api/auth/jwks`));


const uri = process.env.MONGODB_URI;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});


app.post('/api/chat', async (req, res) => {
    const { sessionId, messages } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'messages[] is required' });
    }

    sessionStore.set(sessionId, messages);

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Transfer-Encoding', 'chunked');

    try {
        // Gemini uses 'model' instead of 'assistant', and expects contents as
        // { role, parts: [{ text }] } rather than { role, content }.
        const contents = messages.map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
        }));

        const stream = await ai.models.generateContentStream({
            model: 'gemini-flash-latest',
            contents,
            config: {
                systemInstruction:
                    'You are a helpful, concise assistant embedded in a product chat widget. ' +
                    'Use the prior turns in this conversation to stay consistent and avoid repeating yourself.',
            },
        });

        for await (const chunk of stream) {
            const text = chunk.text;
            if (text) res.write(text);
        }
        res.end();
    } catch (err) {
        console.error('Chat route error:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to generate response' });
        } else {
            res.end();
        }
    }
});


export async function verifyAuth(req, res, next) {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ success: false, error: 'Missing or invalid Authorization header.' });
        }

        const token = authHeader.split(' ')[1];

        const { payload } = await jwtVerify(token, JWKS, {
            issuer: AUTH_SERVER_URL,
        });

        req.userId = payload.sub;
        req.user = payload;

        next();
    } catch (err) {
        console.error('Token verification failed:', err.message);
        return res.status(401).json({ success: false, error: 'Invalid or expired token.' });
    }
}

async function run() {
    try {
        await client.connect();
        const dbName = process.env.AUTH_DB_NAME;
        const db = client.db(dbName);

        const careersCollection = db.collection("careers");
        const savedCareersCollection = db.collection("saved-careers");
        const applicationsCollection = db.collection("applications");
        const usersCollection = db.collection("user");

        // GET: Fetch a single user's profile

        app.get('/api/profile/:userId', verifyAuth, async (req, res) => {
            try {
                const { userId } = req.params;

                if (userId !== req.userId) {
                    return res.status(403).json({ success: false, error: 'Forbidden.' });
                }

                if (!ObjectId.isValid(userId)) {
                    return res.status(400).json({ success: false, error: 'Invalid user ID format.' });
                }

                const user = await usersCollection.findOne(
                    { _id: new ObjectId(userId) },
                    { projection: { name: 1, email: 1, emailVerified: 1, image: 1, createdAt: 1 } }
                );

                if (!user) {
                    return res.status(404).json({ success: false, error: 'User not found.' });
                }

                res.status(200).json({ success: true, data: user });
            } catch (error) {
                console.error("Error fetching profile:", error);
                res.status(500).json({ success: false, error: 'Failed to retrieve profile.' });
            }
        });

        // PATCH: Update name and/or avatar image
        app.patch('/api/profile', verifyAuth, async (req, res) => {
            try {
                const { userId, name, image } = req.body;

                if (!userId || !ObjectId.isValid(userId)) {
                    return res.status(400).json({ success: false, error: 'A valid user ID is required.' });
                }

                const update = { updatedAt: new Date() };
                if (typeof name === 'string' && name.trim()) update.name = name.trim();
                if (typeof image === 'string') update.image = image; // data URL or hosted URL

                if (Object.keys(update).length === 1) {
                    return res.status(400).json({ success: false, error: 'Nothing to update.' });
                }

                const result = await usersCollection.findOneAndUpdate(
                    { _id: new ObjectId(userId) },
                    { $set: update },
                    { returnDocument: 'after', projection: { name: 1, email: 1, emailVerified: 1, image: 1, createdAt: 1 } }
                );

                if (!result) {
                    return res.status(404).json({ success: false, error: 'User not found.' });
                }

                res.status(200).json({ success: true, data: result });
            } catch (error) {
                console.error("Error updating profile:", error);
                res.status(500).json({ success: false, error: 'Failed to update profile.' });
            }
        });

        // GET: Fetch all career listings
        app.get('/api/careers', async (req, res) => {
            try {
                const careers = await careersCollection
                    .find({})
                    .sort({ createdAt: -1 })
                    .toArray();

                res.status(200).json({
                    success: true,
                    count: careers.length,
                    data: careers
                });
            } catch (error) {
                console.error("Error fetching career listings:", error);
                res.status(500).json({
                    error: 'Failed to retrieve career listings due to an internal server error.'
                });
            }
        });

        // GET: Fetch only the careers created by the currently logged-in user
        app.get('/api/my-careers', verifyAuth, async (req, res) => {
            try {
                const { userId } = req.query;

                if (!userId) {
                    return res.status(400).json({ success: false, error: 'User ID is required' });
                }

                const userCareers = await careersCollection
                    .find({ userId: userId })
                    .sort({ createdAt: -1 })
                    .toArray();

                res.status(200).json({
                    success: true,
                    count: userCareers.length,
                    data: userCareers
                });
            } catch (error) {
                console.error("Database error:", error);
                res.status(500).json({ success: false, error: 'Failed to retrieve listings.' });
            }
        });

        // POST: Add a new career listing
        app.post('/api/careers', verifyAuth, async (req, res) => {
            try {
                const {
                    title,
                    category,
                    shortDescription,
                    fullDescription,
                    salaryRange,
                    experienceLevel,
                    location,
                    coverImage,
                    responsibilities,
                    skills,
                    userId,
                    creatorEmail
                } = req.body;

                if (!title || !category || !shortDescription || !fullDescription || !userId) {
                    return res.status(400).json({ error: "Missing required fields, including User Authentication." });
                }

                const newCareerListing = {
                    title,
                    category,
                    shortDescription,
                    fullDescription,
                    salaryRange,
                    experienceLevel,
                    location,
                    imageUrl: coverImage || "https://images.unsplash.com/photo-1586717791821-3f44a563fa4c?q=80&w=80",
                    responsibilities: Array.isArray(responsibilities) ? responsibilities : [],
                    skills: Array.isArray(skills) ? skills : [],
                    userId: userId,
                    creatorEmail,
                    createdAt: new Date()
                };

                const result = await careersCollection.insertOne(newCareerListing);

                return res.status(201).json({
                    success: true,
                    message: "Career listing created successfully!",
                    insertedId: result.insertedId
                });

            } catch (error) {
                console.error("Error creating career listing:", error);
                return res.status(500).json({ error: "Internal server error." });
            }
        });

        // GET: Fetch single career by ID
        app.get('/api/careers/:id', verifyAuth, async (req, res) => {
            try {
                const { id } = req.params;

                if (!ObjectId.isValid(id)) {
                    return res.status(400).json({ error: 'Invalid career ID format.' });
                }

                const career = await careersCollection.findOne({ _id: new ObjectId(id) });

                if (!career) {
                    return res.status(404).json({ error: 'Career insights not found.' });
                }

                return res.status(200).json({
                    success: true,
                    data: career
                });
            } catch (error) {
                console.error(error);
                return res.status(500).json({ error: 'Internal server error while fetching career details.' });
            }
        });

        app.get("/api/saved-careers", verifyAuth, async (req, res) => {
            try {
                const { userId } = req.query;

                if (!userId || !ObjectId.isValid(userId)) {
                    return res.status(400).json({
                        success: false,
                        error: "Valid userId is required.",
                    });
                }

                const saved = await savedCareersCollection
                    .find({
                        userId: new ObjectId(userId),
                    })
                    .sort({ savedAt: -1 })
                    .toArray();

                const careers = await Promise.all(
                    saved.map(async (item) => {
                        const career = await careersCollection.findOne({
                            _id: item.careerId,
                        });

                        return {
                            _id: item._id,
                            savedAt: item.savedAt,
                            career,
                        };
                    })
                );

                res.send({
                    success: true,
                    data: careers,
                });
            } catch (err) {
                console.log(err);

                res.status(500).send({
                    success: false,
                    error: err.message,
                });
            }
        });

        // POST: Save a career
        app.post('/api/saved-careers', verifyAuth, async (req, res) => {
            try {
                const { careerId, userId } = req.body;

                if (!careerId || !ObjectId.isValid(careerId)) {
                    return res.status(400).json({ error: 'A valid career ID is required.' });
                }

                if (!userId || !ObjectId.isValid(userId)) {
                    return res.status(400).json({ error: 'You must be signed in to save a career.' });
                }
                const finalUserId = new ObjectId(userId);

                const existingSave = await savedCareersCollection.findOne({
                    userId: finalUserId,
                    careerId: new ObjectId(careerId)
                });

                if (existingSave) {
                    return res.status(409).json({ error: 'Career already saved.' });
                }

                const newSave = {
                    userId: finalUserId,
                    careerId: new ObjectId(careerId),
                    savedAt: new Date()
                };

                const result = await savedCareersCollection.insertOne(newSave);

                return res.status(201).json({
                    success: true,
                    message: 'Career successfully saved to collection.',
                    insertedId: result.insertedId
                });
            } catch (error) {
                console.error(error);
                return res.status(500).json({ error: 'Internal server error while saving career.' });
            }
        });

        // GET: Fetch the current user's own submitted applications
        app.get("/api/applications", verifyAuth, async (req, res) => {
            try {
                const { userId } = req.query;

                if (!userId) {
                    return res.status(400).json({
                        success: false,
                        error: "User ID is required.",
                    });
                }

                const applications = await applicationsCollection
                    .find({ userId })
                    .sort({ appliedAt: -1 })
                    .toArray();

                const result = await Promise.all(
                    applications.map(async (application) => {

                        let career = null;

                        if (application.careerId) {

                            if (ObjectId.isValid(application.careerId)) {

                                career = await careersCollection.findOne({
                                    _id: new ObjectId(application.careerId),
                                });

                            } else {

                                career = await careersCollection.findOne({
                                    _id: application.careerId,
                                });

                            }
                        }

                        return {
                            _id: application._id,
                            appliedAt: application.appliedAt,
                            resumeUrl: application.resumeUrl,
                            coverLetter: application.coverLetter,
                            status: application.status,

                            career: career
                                ? {
                                    _id: career._id,
                                    title: career.title,
                                    location: career.location,
                                    imageUrl: career.imageUrl,
                                }
                                : null,
                        };
                    })
                );

                res.status(200).json({
                    success: true,
                    data: result,
                });

            } catch (err) {

                console.error(err);

                res.status(500).json({
                    success: false,
                    error: err.message,
                });
            }
        });

        // POST: Submit an application
        app.post("/api/applications", verifyAuth, async (req, res) => {
            try {
                const {
                    careerId,
                    userId,
                    fullName,
                    email,
                    resumeUrl,
                    coverLetter,
                } = req.body;

                if (
                    !careerId ||
                    !userId ||
                    !fullName ||
                    !email ||
                    !resumeUrl
                ) {
                    return res.status(400).json({
                        success: false,
                        error: "All required fields are required.",
                    });
                }

                // একই চাকরিতে আবার apply করা আটকাবে
                const alreadyApplied = await applicationsCollection.findOne({
                    careerId,
                    userId,
                });

                if (alreadyApplied) {
                    return res.status(400).json({
                        success: false,
                        error: "You have already applied for this job.",
                    });
                }

                const application = {
                    careerId,
                    userId,
                    fullName,
                    email,
                    resumeUrl,
                    coverLetter: coverLetter || "",
                    status: "submitted",
                    appliedAt: new Date(),
                };

                const result = await applicationsCollection.insertOne(application);

                res.status(201).json({
                    success: true,
                    insertedId: result.insertedId,
                    message: "Application submitted successfully.",
                });

            } catch (err) {
                console.error(err);

                res.status(500).json({
                    success: false,
                    error: err.message,
                });
            }
        });

        // DELETE: Remove a career listing
        app.delete('/api/careers/:id', verifyAuth, async (req, res) => {
            try {
                const careerId = req.params.id;

                if (!ObjectId.isValid(careerId)) {
                    return res.status(400).json({
                        success: false,
                        error: 'Invalid career listing ID format.'
                    });
                }

                const result = await careersCollection.deleteOne({ _id: new ObjectId(careerId) });

                if (result.deletedCount === 1) {
                    return res.status(200).json({
                        success: true,
                        message: 'Career listing deleted successfully! 🗑️'
                    });
                } else {
                    return res.status(404).json({
                        success: false,
                        error: 'Career listing not found.'
                    });
                }
            } catch (error) {
                console.error("Error deleting career listing:", error);
                return res.status(500).json({
                    success: false,
                    error: 'Internal server error.'
                });
            }
        });



        // POST: AI Image Understanding
        app.post('/api/image-understanding', verifyAuth, async (req, res) => {
            try {
                const { imageBase64, mimeType } = req.body;

                if (!imageBase64 || !mimeType) {
                    return res.status(400).json({ success: false, error: 'imageBase64 and mimeType are required.' });
                }

                const prompt = `Analyze this image and respond with ONLY valid JSON, no markdown fences, no preamble, in this exact shape:
                {
                "caption": "one short punchy caption, max 12 words",
                "description": "2-4 sentence plain-language explanation of what's happening in the image",
                "objects": ["object1", "object2", ...]
                }
                List every distinct object/entity you can confidently identify in "objects" (max 15).`;

                const result = await ai.models.generateContent({
                    model: 'gemini-flash-latest',
                    contents: [{
                        role: 'user',
                        parts: [
                            { inlineData: { mimeType, data: imageBase64 } },
                            { text: prompt },
                        ],
                    }],
                });

                const cleaned = result.text.trim().replace(/^```json\s*|```$/g, '').trim();

                let parsed;
                try {
                    parsed = JSON.parse(cleaned);
                } catch (e) {
                    return res.status(502).json({ success: false, error: 'Model returned unparseable output.' });
                }

                res.status(200).json({ success: true, data: parsed });
            } catch (error) {
                console.error('Image understanding error:', error);
                res.status(500).json({ success: false, error: 'Failed to analyze image.' });
            }
        });


        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } catch (e) {
        console.error("MongoDB connection failed:", e);
    }
}

run().catch(console.dir);

app.get('/', (req, res) => {
    res.send('Server is Serving');
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});