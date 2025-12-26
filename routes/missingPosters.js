import express from 'express';

const router = express.Router();

// In-memory storage for missing posters (replace with MongoDB model in production)
let missingPosters = [];
let nextId = 1;

export const createMissingPosterRoutes = (authenticate) => {
    // Create missing poster
    router.post('/', authenticate, async (req, res) => {
        try {
            const { name, description, contactNumber, photoUri } = req.body;
            const userId = req.user._id;

            if (!name || !description || !contactNumber) {
                return res.status(400).json({ message: 'Name, description, and contact number are required' });
            }

            const poster = {
                id: nextId++,
                userId,
                name,
                description,
                contactNumber,
                photoUri: photoUri || null,
                createdBy: req.user.name || req.user.email,
                createdAt: new Date().toISOString(),
            };

            missingPosters.push(poster);

            // TODO: Broadcast to all connected users via WebSocket
            // if (io) {
            //     io.emit('missing-poster-created', poster);
            // }

            res.status(201).json({
                message: 'Missing poster created successfully',
                poster: poster
            });
        } catch (error) {
            console.error('Error creating missing poster:', error);
            res.status(500).json({ message: 'Server error' });
        }
    });

    // Get all missing posters
    router.get('/', authenticate, async (req, res) => {
        try {
            // Return most recent 50 posters
            const recentPosters = missingPosters
                .slice()
                .reverse()
                .slice(0, 50);

            res.json(recentPosters);
        } catch (error) {
            console.error('Error fetching missing posters:', error);
            res.status(500).json({ message: 'Server error' });
        }
    });

    // Delete missing poster (only by creator)
    router.delete('/:id', authenticate, async (req, res) => {
        try {
            const posterId = parseInt(req.params.id);
            const userId = req.user._id.toString();

            const posterIndex = missingPosters.findIndex(p =>
                p.id === posterId && p.userId.toString() === userId
            );

            if (posterIndex === -1) {
                return res.status(404).json({ message: 'Poster not found or unauthorized' });
            }

            missingPosters.splice(posterIndex, 1);
            res.json({ message: 'Poster deleted successfully' });
        } catch (error) {
            console.error('Error deleting missing poster:', error);
            res.status(500).json({ message: 'Server error' });
        }
    });

    return router;
};
