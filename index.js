import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import { MongoClient, ServerApiVersion, ObjectId } from 'mongodb';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const sessionStore = new Map();

const uri = process.env.MONGODB_URI;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

// ---- /api/chat: doesn't touch the DB, so it can be registered immediately ----
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

async function run() {
    try {
        await client.connect();
        const dbName = process.env.AUTH_DB_NAME;
        const db = client.db(dbName);

        const careersCollection = db.collection("careers");
        const savedCareersCollection = db.collection("saved-careers");
        const applicationsCollection = db.collection("applications");

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
        app.get('/api/my-careers', async (req, res) => {
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
        app.post('/api/careers', async (req, res) => {
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
        app.get('/api/careers/:id', async (req, res) => {
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

        // POST: Save a career
        app.post('/api/saved-careers', async (req, res) => {
            try {
                const { careerId, userId } = req.body;

                if (!careerId || !ObjectId.isValid(careerId)) {
                    return res.status(400).json({ error: 'A valid career ID is required.' });
                }

                const finalUserId = userId && ObjectId.isValid(userId) ? new ObjectId(userId) : new ObjectId("60c72b2f9b1d8b2bad888888");

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

        // POST: Submit an application
        app.post('/api/applications', async (req, res) => {
            try {
                const { careerId, fullName, email, resumeUrl, coverLetter, userId } = req.body;

                if (!careerId || !ObjectId.isValid(careerId)) {
                    return res.status(400).json({ error: 'A valid career ID is required.' });
                }

                if (!fullName?.trim() || !email?.trim() || !resumeUrl?.trim()) {
                    return res.status(400).json({ error: 'Full name, email, and resume link are mandatory.' });
                }

                const finalUserId = userId && ObjectId.isValid(userId) ? new ObjectId(userId) : new ObjectId("60c72b2f9b1d8b2bad888888");

                const newApplication = {
                    userId: finalUserId,
                    careerId: new ObjectId(careerId),
                    fullName: fullName.trim(),
                    email: email.trim(),
                    resumeUrl: resumeUrl.trim(),
                    coverLetter: coverLetter ? coverLetter.trim() : null,
                    appliedAt: new Date()
                };

                const result = await applicationsCollection.insertOne(newApplication);

                return res.status(201).json({
                    success: true,
                    message: 'Application successfully processed.',
                    insertedId: result.insertedId
                });
            } catch (error) {
                console.error(error);
                return res.status(500).json({ error: 'Internal server error while processing application.' });
            }
        });

        // DELETE: Remove a career listing
        app.delete('/api/careers/:id', async (req, res) => {
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