const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

const uri = process.env.MONGODB_URI;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});
async function run() {
    try {
        await client.connect();
        const dbName = process.env.AUTH_DB_NAME;
        const db = client.db(dbName);

        const careersCollection = db.collection("careers");
        const sessionsCollection = db.collection("session");
        const usersCollection = db.collection("user");
        const savedCareersCollection = db.collection("saved-careers");
        const applicationsCollection = db.collection("applications");


        // GET: Fetch all career listings
        app.get('/api/careers', async (req, res) => {
            try {
                // Fetch all listings from the collection and sort by newest first
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

                const userCareers = await careersCollection
                    .find({ userId: req.userId })
                    .sort({ createdAt: -1 })
                    .toArray();

                res.status(200).json({
                    success: true,
                    count: userCareers.length,
                    data: userCareers
                });
            } catch (error) {
                console.error("Error fetching user's specific career listings:", error);
                res.status(500).json({
                    error: 'Failed to retrieve your career listings.'
                });
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

        app.post('/api/saved-careers', async (req, res) => {
            try {
                const { careerId, userId } = req.body; // 👈 ফ্রন্টএন্ড থেকে userId পাঠানো যেতে পারে অথবা ডামি আইডি

                if (!careerId || !ObjectId.isValid(careerId)) {
                    return res.status(400).json({ error: 'A valid career ID is required.' });
                }

                // অথেনটিকেশন না থাকলে ডামি আইডি বা ফ্রন্টএন্ডের আইডি ব্যবহার
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

        // await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // await client.close();
    }
}
run().catch(console.dir);


app.get('/', (req, res) => {
    res.send('Server is Serving')
})

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`)
})