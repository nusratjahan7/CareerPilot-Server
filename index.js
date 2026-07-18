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
        const sessionsCollection = db.collection("session"); // Default Better-Auth session collection name
        const usersCollection = db.collection("user");       // Default Better-Auth user collection name

        console.log("Pinged your deployment. You successfully connected to MongoDB!");

        // --- Custom Authentication Middleware ---
        const authenticateUser = async (req, res, next) => {
            try {
                const authHeader = req.headers.authorization;
                if (!authHeader || !authHeader.startsWith('Bearer ')) {
                    return res.status(401).json({ error: 'Unauthorized access. Token missing.' });
                }

                const token = authHeader.split(' ')[1];

                const sessionRecord = await sessionsCollection.findOne({ token: token });

                if (!sessionRecord) {
                    return res.status(401).json({ error: 'Invalid or expired session token.' });
                }


                if (new Date(sessionRecord.expiresAt) < new Date()) {
                    return res.status(401).json({ error: 'Session token has expired.' });
                }

                req.userId = sessionRecord.userId;
                next();
            } catch (error) {
                console.error("Auth Middleware Error:", error);
                res.status(500).json({ error: 'Internal Server Error validating authentication.' });
            }
        };

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
        app.get('/api/my-careers', authenticateUser, async (req, res) => {
            try {
                // req.userId is automatically populated by your authenticateUser middleware
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
        app.post('/api/careers', authenticateUser, async (req, res) => {
            try {
                const { title, category, shortDescription, fullDescription, salaryRange, experienceLevel, coverImage } = req.body;

                // Server-side structural validation check
                if (!title || !category || !shortDescription || !fullDescription || !salaryRange || !experienceLevel) {
                    return res.status(400).json({ error: 'All fields marked with an asterisk (*) are mandatory.' });
                }

                const newCareerListing = {
                    userId: req.userId,
                    title,
                    category,
                    shortDescription,
                    fullDescription,
                    salaryRange,
                    experienceLevel,
                    coverImage: coverImage || null,
                    createdAt: new Date()
                };

                const result = await careersCollection.insertOne(newCareerListing);

                res.status(201).json({
                    success: true,
                    message: 'Career listing successfully created.',
                    insertedId: result.insertedId
                });

            } catch (error) {
                console.error("Error creating career listing:", error);
                res.status(500).json({ error: 'Failed to create career listing due to internal database error.' });
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