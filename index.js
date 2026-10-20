const express = require('express');
const { MongoClient } = require('mongodb');
const cookieParser = require('cookie-parser');
const adminRouter = require('./admin');

const app = express();
app.use(express.json());
app.use(cookieParser());

// Database Connection Management (Cached for Serverless)
let cachedClient = null;
let cachedDb = null;

async function connectToDatabase() {
    if (cachedClient && cachedDb) return { client: cachedClient, db: cachedDb };
    
    const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017';
    const client = new MongoClient(uri);
    await client.connect();
    const db = client.db(process.env.MONGODB_DB || 'smilecraft_clinic');
    
    // Create necessary indexes
    await db.collection('appointments').createIndex({ startAt: 1, endAt: 1 });
    await db.collection('appointments').createIndex({ bookingReference: 1 }, { unique: true });
    
    // Initial Seeding for Demonstration Context
    const serviceCount = await db.collection('services').countDocuments();
    if (serviceCount === 0) {
        await db.collection('services').insertMany([
            { name: 'General Dental Consultation', slug: 'consultation', description: 'Comprehensive oral examination.', price: 500, priceLabel: 'NPR 500', durationMinutes: 30, active: true },
            { name: 'Dental Cleaning & Scaling', slug: 'cleaning', description: 'Professional plaque and tartar removal.', price: 1500, priceLabel: 'NPR 1,500', durationMinutes: 45, active: true },
            { name: 'Teeth Whitening', slug: 'whitening', description: 'Advanced laser teeth whitening.', price: 5000, priceLabel: 'NPR 5,000', durationMinutes: 60, active: true },
            { name: 'Root Canal Treatment', slug: 'rct', description: 'Painless root canal therapy.', price: 8000, priceLabel: 'From NPR 8,000', durationMinutes: 90, active: true },
            { name: 'Dental Implants', slug: 'implants', description: 'Permanent tooth replacement solutions.', price: 35000, priceLabel: 'From NPR 35,000', durationMinutes: 120, active: true }
        ]);
        await db.collection('dentists').insertMany([
            { name: 'Dr. Aarav Sharma', specialty: 'General Dentistry', bio: 'Expert in routine dental care and family dentistry.', active: true },
            { name: 'Dr. Sushma Adhikari', specialty: 'Restorative Dentistry', bio: 'Specialist in RCT and cosmetic restorations.', active: true },
            { name: 'Dr. Nisha Karki', specialty: 'Orthodontic Consultation', bio: 'Focuses on braces, aligners, and smile correction.', active: true }
        ]);
    }

    cachedClient = client;
    cachedDb = db;
    return { client, db };
}

// Global Middleware to attach DB
app.use(async (req, res, next) => {
    try {
        const { db } = await connectToDatabase();
        req.db = db;
        next();
    } catch (error) {
        console.error('Database connection failed:', error);
        res.status(500).json({ error: 'Database connection failed' });
    }
});

// Mount Admin Routes
app.use('/admin', adminRouter);

// PUBLIC APIs

app.get('/api/services', async (req, res) => {
    const services = await req.db.collection('services').find({ active: true }).toArray();
    res.json(services);
});

app.get('/api/dentists', async (req, res) => {
    const dentists = await req.db.collection('dentists').find({ active: true }).toArray();
    res.json(dentists);
});

// Get Available Slots
app.get('/api/slots', async (req, res) => {
    const { date, serviceId } = req.query; // date format: YYYY-MM-DD
    if (!date || !serviceId) return res.status(400).json({ error: 'Missing parameters' });

    const { ObjectId } = require('mongodb');
    const service = await req.db.collection('services').findOne({ _id: new ObjectId(serviceId) });
    if (!service) return res.status(404).json({ error: 'Service not found' });
    const duration = service.durationMinutes || 30;

    // Clinic Time: Asia/Kathmandu 09:00 to 18:00
    // We generate slots assuming "date" is local Kathmandu date
    const slots = [];
    for (let hour = 9; hour < 18; hour++) {
        for (let min of [0, 30]) {
            const hStr = hour.toString().padStart(2, '0');
            const mStr = min.toString().padStart(2, '0');
            const timeString = `${date}T${hStr}:${mStr}:00+05:45`; // Kathmandu TZ offset
            
            const startAt = new Date(timeString);
            const endAt = new Date(startAt.getTime() + duration * 60000);
            
            // Cannot exceed 18:00
            const endHour = parseInt(endAt.toLocaleString('en-US', { timeZone: 'Asia/Kathmandu', hour: 'numeric', hour12: false }));
            const endMin = parseInt(endAt.toLocaleString('en-US', { timeZone: 'Asia/Kathmandu', minute: 'numeric' }));
            if (endHour > 18 || (endHour === 18 && endMin > 0)) continue;
            
            // Cannot book in the past
            if (startAt < new Date()) continue;
            
            slots.push({ timeLabel: `${hour > 12 ? hour - 12 : hour}:${mStr} ${hour >= 12 ? 'PM' : 'AM'}`, startAt, endAt });
        }
    }

    // Filter overlapping existing appointments
    const dayStart = new Date(`${date}T00:00:00+05:45`);
    const dayEnd = new Date(`${date}T23:59:59+05:45`);
    const existingAppointments = await req.db.collection('appointments').find({
        startAt: { $gte: dayStart, $lte: dayEnd },
        status: { $nin: ['Cancelled', 'Rejected'] }
    }).toArray();

    const availableSlots = slots.filter(slot => {
        const overlap = existingAppointments.some(app => {
            const appStart = new Date(app.startAt);
            const appEnd = new Date(app.endAt);
            return (slot.startAt < appEnd && slot.endAt > appStart);
        });
        return !overlap;
    });

    res.json(availableSlots);
});

// Book Appointment
app.post('/api/book', async (req, res) => {
    const { patientName, patientPhone, patientEmail, serviceId, startAt, endAt, notes } = req.body;
    
    // Basic server-side validation
    if (!patientName || !patientPhone || !serviceId || !startAt || !endAt) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    // Concurrency check (Check overlaps again atomicallyish before insert)
    const sDate = new Date(startAt);
    const eDate = new Date(endAt);
    const conflict = await req.db.collection('appointments').findOne({
        status: { $nin: ['Cancelled', 'Rejected'] },
        $or: [
            { startAt: { $lt: eDate }, endAt: { $gt: sDate } }
        ]
    });

    if (conflict) {
        return res.status(409).json({ error: 'Selected time slot is no longer available. Please choose another.' });
    }

    const { ObjectId } = require('mongodb');
    const service = await req.db.collection('services').findOne({ _id: new ObjectId(serviceId) });

    const refNo = 'SMILE-' + Math.floor(100000 + Math.random() * 900000);
    const appointment = {
        bookingReference: refNo,
        patientName,
        patientPhone,
        patientEmail,
        serviceId: new ObjectId(serviceId),
        serviceName: service ? service.name : 'Consultation',
        startAt: sDate,
        endAt: eDate,
        status: 'Pending',
        patientNotes: notes || '',
        createdAt: new Date(),
        updatedAt: new Date()
    };

    await req.db.collection('appointments').insertOne(appointment);
    res.json({ success: true, bookingReference: refNo, status: appointment.status });
});


// Serve Public Frontend (HTML/CSS/JS embedded)
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SmileCraft Dental Care & Implant Center | Kathmandu, Nepal</title>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <script src="https://unpkg.com/lucide@latest"></script>
    <style>
        :root {
            --primary: #27B8A5; --primary-dark: #159786; --secondary: #77C8F4;
            --accent: #FF8F87; --lavender: #DCD5FF; --bg: #F5F8FC; --surface: #FFFFFF;
            --text: #203047; --muted: #718096; --yellow: #FFE8A1;
            
            --clay-shadow: 12px 12px 24px #d9e0e8, -12px -12px 24px #ffffff;
            --clay-inset: inset 6px 6px 12px #d9e0e8, inset -6px -6px 12px #ffffff;
            --clay-hover: 16px 16px 32px #d9e0e8, -16px -16px 32px #ffffff;
            --clay-sm: 6px 6px 12px #d9e0e8, -6px -6px 12px #ffffff;
        }

        * { margin: 0; padding: 0; box-sizing: border-box; font-family: 'Plus Jakarta Sans', sans-serif; scroll-behavior: smooth; }
        body { background-color: var(--bg); color: var(--text); line-height: 1.6; overflow-x: hidden; }

        /* Typography & Utils */
        h1, h2, h3 { font-weight: 700; line-height: 1.2; color: var(--text); }
        .text-center { text-align: center; }
        .text-primary { color: var(--primary); }
        .text-muted { color: var(--muted); }
        .section-padding { padding: 5rem 1rem; }
        .container { max-width: 1200px; margin: 0 auto; padding: 0 1rem; }
        
        /* Components */
        .clay-card { background: var(--surface); border-radius: 24px; box-shadow: var(--clay-shadow); padding: 2rem; transition: all 0.3s ease; }
        .clay-card:hover { transform: translateY(-5px); box-shadow: var(--clay-hover); }
        
        .clay-btn { background: var(--primary); color: white; border: none; border-radius: 16px; padding: 1rem 2rem; font-size: 1rem; font-weight: 600; cursor: pointer; box-shadow: var(--clay-sm); transition: all 0.2s; display: inline-flex; align-items: center; gap: 0.5rem; text-decoration: none; justify-content: center; }
        .clay-btn:hover { background: var(--primary-dark); transform: translateY(-2px); box-shadow: var(--clay-shadow); }
        .clay-btn-accent { background: var(--accent); }
        .clay-btn-accent:hover { background: #E67A72; }
        .clay-btn-outline { background: var(--bg); color: var(--primary); }
        
        .clay-input { width: 100%; background: var(--bg); border: none; border-radius: 16px; padding: 1rem; font-size: 1rem; color: var(--text); box-shadow: var(--clay-inset); outline: none; margin-bottom: 1rem; transition: all 0.2s; }
        .clay-input:focus { box-shadow: inset 8px 8px 16px #d9e0e8, inset -8px -8px 16px #ffffff; }

        /* Navigation */
        nav { background: rgba(245, 248, 252, 0.9); backdrop-filter: blur(10px); position: sticky; top: 0; z-index: 100; padding: 1rem 0; box-shadow: 0 4px 20px rgba(0,0,0,0.03); }
        .nav-container { display: flex; justify-content: space-between; align-items: center; }
        .logo { display: flex; align-items: center; gap: 0.5rem; font-size: 1.5rem; font-weight: 800; color: var(--primary); text-decoration: none; }
        .nav-links { display: flex; gap: 2rem; align-items: center; }
        .nav-links a { color: var(--text); text-decoration: none; font-weight: 600; transition: color 0.2s; }
        .nav-links a:hover { color: var(--primary); }
        @media (max-width: 768px) { .nav-links { display: none; } }

        /* Hero */
        .hero { min-height: 80vh; display: flex; align-items: center; position: relative; overflow: hidden; padding: 4rem 1rem; }
        .hero-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4rem; align-items: center; }
        .hero-content h1 { font-size: 3.5rem; margin-bottom: 1.5rem; }
        .hero-content p { font-size: 1.2rem; color: var(--muted); margin-bottom: 2rem; }
        .hero-btns { display: flex; gap: 1rem; }
        .hero-image-wrapper { position: relative; }
        .hero-img { width: 100%; border-radius: 30% 70% 70% 30% / 30% 30% 70% 70%; box-shadow: var(--clay-shadow); object-fit: cover; aspect-ratio: 1; }
        .floating-badge { position: absolute; background: var(--surface); padding: 1rem; border-radius: 20px; box-shadow: var(--clay-shadow); display: flex; align-items: center; gap: 1rem; animation: float 6s ease-in-out infinite; }
        .badge-1 { top: 10%; left: -10%; animation-delay: 0s; }
        .badge-2 { bottom: 10%; right: -10%; animation-delay: 3s; }
        
        @keyframes float { 0% { transform: translateY(0px); } 50% { transform: translateY(-20px); } 100% { transform: translateY(0px); } }
        @media (max-width: 768px) { .hero-grid { grid-template-columns: 1fr; text-align: center; } .hero-btns { justify-content: center; flex-direction: column; } .hero-content h1 { font-size: 2.5rem; } }

        /* Highlights */
        .highlights { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 2rem; margin-top: -3rem; position: relative; z-index: 10; }
        .highlight-card { text-align: center; padding: 2rem 1.5rem; }
        .highlight-icon { width: 60px; height: 60px; background: var(--bg); border-radius: 50%; display: flex; justify-content: center; align-items: center; margin: 0 auto 1rem; color: var(--primary); box-shadow: var(--clay-shadow); }

        /* Services */
        .services-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 2rem; margin-top: 3rem; }
        .service-card { display: flex; flex-direction: column; height: 100%; }
        .service-card h3 { margin-bottom: 1rem; color: var(--primary-dark); }
        .service-price { display: inline-block; background: var(--bg); padding: 0.5rem 1rem; border-radius: 12px; font-weight: 700; color: var(--accent); box-shadow: var(--clay-inset); margin: 1rem 0; }

        /* Dentists */
        .dentists-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 2rem; margin-top: 3rem; }
        .dentist-card { text-align: center; }
        .dentist-avatar { width: 120px; height: 120px; background: var(--lavender); border-radius: 50%; margin: 0 auto 1.5rem; display: flex; justify-content: center; align-items: center; box-shadow: var(--clay-shadow); }

        /* Booking Section / Modal */
        .booking-overlay { position: fixed; inset: 0; background: rgba(32, 48, 71, 0.5); backdrop-filter: blur(5px); z-index: 1000; display: none; justify-content: center; align-items: center; padding: 1rem; }
        .booking-modal { background: var(--bg); width: 100%; max-width: 600px; border-radius: 32px; box-shadow: 0 20px 40px rgba(0,0,0,0.1); padding: 3rem 2rem; max-height: 90vh; overflow-y: auto; position: relative; }
        .close-btn { position: absolute; top: 1.5rem; right: 1.5rem; background: var(--surface); border: none; width: 40px; height: 40px; border-radius: 50%; display: flex; justify-content: center; align-items: center; cursor: pointer; box-shadow: var(--clay-shadow); color: var(--muted); }
        
        .step-indicator { display: flex; justify-content: center; gap: 1rem; margin-bottom: 2rem; }
        .step-dot { width: 12px; height: 12px; border-radius: 50%; background: #d9e0e8; box-shadow: var(--clay-inset); }
        .step-dot.active { background: var(--primary); box-shadow: none; }

        .booking-step { display: none; }
        .booking-step.active { display: block; animation: fadeIn 0.3s ease; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

        .slot-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 1rem; margin: 1.5rem 0; }
        .slot-btn { background: var(--surface); border: none; padding: 0.8rem; border-radius: 12px; font-weight: 600; cursor: pointer; box-shadow: var(--clay-shadow); transition: 0.2s; color: var(--text); }
        .slot-btn:hover, .slot-btn.selected { background: var(--primary); color: white; transform: translateY(-2px); }

        /* Footer */
        footer { background: var(--surface); padding: 4rem 1rem 2rem; box-shadow: 0 -10px 30px rgba(0,0,0,0.02); margin-top: 4rem; }
        .footer-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 3rem; margin-bottom: 3rem; }
        .footer-col h4 { margin-bottom: 1.5rem; color: var(--primary-dark); }
        .footer-col p, .footer-col a { color: var(--muted); text-decoration: none; margin-bottom: 0.8rem; display: block; }
    </style>
</head>
<body>

    <!-- Navigation -->
    <nav>
        <div class="container nav-container">
            <a href="#" class="logo"><i data-lucide="smile"></i> SmileCraft</a>
            <div class="nav-links">
                <a href="#services">Services</a>
                <a href="#dentists">Our Dentists</a>
                <a href="#about">About Us</a>
                <button class="clay-btn" onclick="openBooking()"><i data-lucide="calendar-plus"></i> Book Online</button>
            </div>
        </div>
    </nav>

    <!-- Hero -->
    <header class="hero container">
        <div class="hero-grid">
            <div class="hero-content">
                <h1>Your Healthier Smile Starts Here.</h1>
                <p>Experience premium, painless dental care in Kathmandu. Our expert team combines advanced technology with a warm, patient-first approach.</p>
                <div class="hero-btns">
                    <button class="clay-btn clay-btn-accent" onclick="openBooking()">Book Appointment</button>
                    <a href="#services" class="clay-btn clay-btn-outline">Explore Services</a>
                </div>
            </div>
            <div class="hero-image-wrapper">
                <img src="https://images.unsplash.com/photo-1606811841689-23dfddce3e95?ixlib=rb-4.0.3&auto=format&fit=crop&w=800&q=80" alt="Smiling patient at dental clinic" class="hero-img">
                <div class="floating-badge badge-1">
                    <div style="background: var(--secondary); padding: 0.5rem; border-radius: 50%; color: white;"><i data-lucide="star"></i></div>
                    <div><strong>Top Rated</strong><br><small class="text-muted">In Kathmandu</small></div>
                </div>
                <div class="floating-badge badge-2">
                    <div style="background: var(--primary); padding: 0.5rem; border-radius: 50%; color: white;"><i data-lucide="clock"></i></div>
                    <div><strong>Sun - Fri</strong><br><small class="text-muted">9 AM - 6 PM</small></div>
                </div>
            </div>
        </div>
    </header>

    <!-- Highlights -->
    <div class="container highlights">
        <div class="clay-card highlight-card">
            <div class="highlight-icon"><i data-lucide="shield-check"></i></div>
            <h3>Expert Professionals</h3>
            <p class="text-muted" style="margin-top: 0.5rem; font-size: 0.9rem;">Highly qualified dental specialists</p>
        </div>
        <div class="clay-card highlight-card">
            <div class="highlight-icon"><i data-lucide="laptop"></i></div>
            <h3>Modern Equipment</h3>
            <p class="text-muted" style="margin-top: 0.5rem; font-size: 0.9rem;">Advanced painless technology</p>
        </div>
        <div class="clay-card highlight-card">
            <div class="highlight-icon"><i data-lucide="calendar-check"></i></div>
            <h3>Easy Scheduling</h3>
            <p class="text-muted" style="margin-top: 0.5rem; font-size: 0.9rem;">Instant online booking</p>
        </div>
    </div>

    <!-- Services Section -->
    <section id="services" class="section-padding" style="background: var(--surface); margin-top: 5rem;">
        <div class="container">
            <div class="text-center" style="max-width: 600px; margin: 0 auto;">
                <h2 class="text-primary">Our Dental Services</h2>
                <p class="text-muted" style="margin-top: 1rem;">Comprehensive dental care tailored to your needs. *Prices are indicative and may vary after clinical assessment.</p>
            </div>
            <div class="services-grid" id="servicesGrid">
                <div class="text-center text-muted" style="grid-column: 1/-1;">Loading services...</div>
            </div>
        </div>
    </section>

    <!-- Dentists Section -->
    <section id="dentists" class="section-padding container">
        <div class="text-center" style="max-width: 600px; margin: 0 auto;">
            <h2>Meet Our <span class="text-primary">Specialists</span></h2>
            <p class="text-muted" style="margin-top: 1rem;">(Demonstration Profiles)</p>
        </div>
        <div class="dentists-grid" id="dentistsGrid"></div>
    </section>

    <!-- Appointment Process -->
    <section class="section-padding" style="background: var(--surface);">
        <div class="container text-center">
            <h2 style="margin-bottom: 3rem;">How to Book</h2>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 2rem;">
                <div>
                    <div style="width: 80px; height: 80px; background: var(--bg); border-radius: 50%; box-shadow: var(--clay-shadow); display: flex; align-items: center; justify-content: center; margin: 0 auto 1rem; color: var(--primary); font-size: 1.5rem; font-weight: bold;">1</div>
                    <h4>Select Service</h4>
                </div>
                <div>
                    <div style="width: 80px; height: 80px; background: var(--bg); border-radius: 50%; box-shadow: var(--clay-shadow); display: flex; align-items: center; justify-content: center; margin: 0 auto 1rem; color: var(--primary); font-size: 1.5rem; font-weight: bold;">2</div>
                    <h4>Choose Date & Time</h4>
                </div>
                <div>
                    <div style="width: 80px; height: 80px; background: var(--bg); border-radius: 50%; box-shadow: var(--clay-shadow); display: flex; align-items: center; justify-content: center; margin: 0 auto 1rem; color: var(--primary); font-size: 1.5rem; font-weight: bold;">3</div>
                    <h4>Enter Details</h4>
                </div>
                <div>
                    <div style="width: 80px; height: 80px; background: var(--bg); border-radius: 50%; box-shadow: var(--clay-shadow); display: flex; align-items: center; justify-content: center; margin: 0 auto 1rem; color: var(--primary); font-size: 1.5rem; font-weight: bold;">4</div>
                    <h4>Confirmed!</h4>
                </div>
            </div>
        </div>
    </section>

    <!-- Booking Overlay / Modal -->
    <div class="booking-overlay" id="bookingModal">
        <div class="booking-modal">
            <button class="close-btn" onclick="closeBooking()"><i data-lucide="x"></i></button>
            <h2 class="text-center" style="margin-bottom: 0.5rem; color: var(--primary-dark);">Book Appointment</h2>
            <p class="text-center text-muted" style="margin-bottom: 2rem;">Fast and secure online scheduling</p>
            
            <div class="step-indicator" id="stepIndicator">
                <div class="step-dot active"></div><div class="step-dot"></div><div class="step-dot"></div><div class="step-dot"></div>
            </div>

            <!-- Step 1: Service -->
            <div class="booking-step active" id="step1">
                <h3 style="margin-bottom: 1rem;">1. Select Service</h3>
                <select class="clay-input" id="bookService" style="cursor: pointer;">
                    <option value="" disabled selected>Choose a dental service...</option>
                </select>
                <div style="text-align: right; margin-top: 2rem;">
                    <button class="clay-btn" onclick="nextStep(2)">Continue <i data-lucide="arrow-right"></i></button>
                </div>
            </div>

            <!-- Step 2: Date & Slots -->
            <div class="booking-step" id="step2">
                <h3 style="margin-bottom: 1rem;">2. Select Date & Time</h3>
                <label class="text-muted" style="font-size: 0.9rem;">Preferred Date</label>
                <input type="date" class="clay-input" id="bookDate" onchange="fetchSlots()" min="">
                
                <div id="slotContainer" style="display: none;">
                    <label class="text-muted" style="font-size: 0.9rem;">Available Times (Asia/Kathmandu)</label>
                    <div class="slot-grid" id="slotsGrid"></div>
                </div>
                <div id="slotLoading" style="display: none; text-align: center; color: var(--primary); padding: 1rem;">Checking availability...</div>
                
                <div style="display: flex; justify-content: space-between; margin-top: 2rem;">
                    <button class="clay-btn clay-btn-outline" onclick="nextStep(1)">Back</button>
                    <button class="clay-btn" id="btnStep2Next" onclick="nextStep(3)" disabled>Continue <i data-lucide="arrow-right"></i></button>
                </div>
            </div>

            <!-- Step 3: Details -->
            <div class="booking-step" id="step3">
                <h3 style="margin-bottom: 1rem;">3. Patient Details</h3>
                <input type="text" class="clay-input" id="patientName" placeholder="Full Name" required>
                <input type="tel" class="clay-input" id="patientPhone" placeholder="Mobile Number (Nepal)" required>
                <input type="email" class="clay-input" id="patientEmail" placeholder="Email Address (Optional)">
                <textarea class="clay-input" id="patientNotes" placeholder="Reason for visit / specific concerns (Optional)" rows="2"></textarea>
                
                <div style="display: flex; justify-content: space-between; margin-top: 2rem;">
                    <button class="clay-btn clay-btn-outline" onclick="nextStep(2)">Back</button>
                    <button class="clay-btn" onclick="nextStep(4)">Review <i data-lucide="arrow-right"></i></button>
                </div>
            </div>

            <!-- Step 4: Review & Submit -->
            <div class="booking-step" id="step4">
                <h3 style="margin-bottom: 1rem;">4. Review & Confirm</h3>
                <div class="clay-card" style="box-shadow: var(--clay-inset); background: transparent; margin-bottom: 2rem;">
                    <p><strong>Service:</strong> <span id="reviewService"></span></p>
                    <p><strong>Date & Time:</strong> <span id="reviewDateTime"></span></p>
                    <p><strong>Patient:</strong> <span id="reviewName"></span></p>
                    <p><strong>Phone:</strong> <span id="reviewPhone"></span></p>
                </div>
                <div id="bookingError" style="color: var(--accent); margin-bottom: 1rem; text-align: center;"></div>
                
                <div style="display: flex; justify-content: space-between;">
                    <button class="clay-btn clay-btn-outline" onclick="nextStep(3)">Back</button>
                    <button class="clay-btn clay-btn-accent" id="submitBookingBtn" onclick="submitBooking()">Confirm Booking</button>
                </div>
            </div>

            <!-- Success -->
            <div class="booking-step" id="stepSuccess" style="text-align: center;">
                <div style="width: 80px; height: 80px; background: #d4edda; color: #155724; border-radius: 50%; display: flex; justify-content: center; align-items: center; font-size: 2rem; margin: 0 auto 1.5rem;"><i data-lucide="check-circle"></i></div>
                <h2 style="color: var(--primary-dark); margin-bottom: 1rem;">Booking Confirmed!</h2>
                <p>Your booking reference is:</p>
                <h3 style="font-size: 2rem; color: var(--accent); margin: 1rem 0;" id="successRef"></h3>
                <p class="text-muted" style="margin-bottom: 2rem;">Our clinic staff will be ready to welcome you. You can use this reference to track your appointment.</p>
                <button class="clay-btn" onclick="closeBooking()">Done</button>
            </div>
        </div>
    </div>

    <!-- Footer -->
    <footer>
        <div class="container footer-grid">
            <div class="footer-col">
                <h4>SmileCraft Dental</h4>
                <p><i data-lucide="map-pin" style="width: 16px;"></i> Near New Baneshwor Chowk, Kathmandu, Nepal</p>
                <p><i data-lucide="phone" style="width: 16px;"></i> +977-9800000001</p>
                <p><i data-lucide="mail" style="width: 16px;"></i> hello@smilecraft.example</p>
                <p style="font-size: 0.8rem; margin-top: 1rem;" class="text-muted">*Demonstration Identity Only</p>
            </div>
            <div class="footer-col">
                <h4>Quick Links</h4>
                <a href="#services">Our Services</a>
                <a href="#dentists">Meet the Dentists</a>
                <a href="#">Patient FAQs</a>
                <a href="/admin" target="_blank" style="color: var(--primary);"><i data-lucide="lock" style="width: 14px;"></i> Staff Portal</a>
            </div>
            <div class="footer-col">
                <h4>Opening Hours</h4>
                <p>Sunday - Friday<br>9:00 AM - 6:00 PM</p>
                <p>Saturday<br>Closed / By Appointment</p>
            </div>
        </div>
        <div class="container text-center text-muted" style="border-top: 1px solid #e2e8f0; padding-top: 2rem; font-size: 0.9rem;">
            &copy; 2026 SmileCraft Dental Care & Implant Center. Designed with Premium Claymorphism.
        </div>
    </footer>

    <script>
        // Init Icons
        lucide.createIcons();

        // Global State
        let servicesData = [];
        let dentistsData = [];
        let bookingState = {
            serviceId: null, serviceName: '', date: '', startAt: null, endAt: null, timeLabel: ''
        };

        // Date Restrictions
        const today = new Date().toLocaleString("en-CA", { timeZone: "Asia/Kathmandu" }).split(',')[0];
        document.getElementById('bookDate').min = today;

        async function loadData() {
            try {
                // Fetch Services
                const sRes = await fetch('/api/services');
                servicesData = await sRes.json();
                
                const sGrid = document.getElementById('servicesGrid');
                const sSelect = document.getElementById('bookService');
                sGrid.innerHTML = '';
                
                servicesData.forEach(srv => {
                    // Populate Page
                    sGrid.innerHTML += \`
                        <div class="clay-card service-card">
                            <h3>\${srv.name}</h3>
                            <p class="text-muted" style="flex: 1;">\${srv.description}</p>
                            <div>
                                <span class="service-price">\${srv.priceLabel}</span>
                            </div>
                            <button class="clay-btn clay-btn-outline" style="width: 100%; margin-top: 1rem;" onclick="preselectBooking('\${srv._id}')">Book This</button>
                        </div>
                    \`;
                    // Populate Select
                    sSelect.innerHTML += \`<option value="\${srv._id}">\${srv.name} (\${srv.durationMinutes} min)</option>\`;
                });

                // Fetch Dentists
                const dRes = await fetch('/api/dentists');
                dentistsData = await dRes.json();
                const dGrid = document.getElementById('dentistsGrid');
                dGrid.innerHTML = '';
                
                dentistsData.forEach(doc => {
                    dGrid.innerHTML += \`
                        <div class="clay-card dentist-card">
                            <div class="dentist-avatar"><i data-lucide="user" style="width: 48px; height: 48px; color: var(--primary);"></i></div>
                            <h3>\${doc.name}</h3>
                            <p class="text-primary" style="font-weight: 600; margin-bottom: 0.5rem;">\${doc.specialty}</p>
                            <p class="text-muted" style="font-size: 0.9rem;">\${doc.bio}</p>
                        </div>
                    \`;
                });
                lucide.createIcons();
            } catch (e) {
                console.error("Failed to load clinical data", e);
            }
        }

        // Booking Logic
        function openBooking() {
            document.getElementById('bookingModal').style.display = 'flex';
            document.body.style.overflow = 'hidden';
            nextStep(1);
        }
        function closeBooking() {
            document.getElementById('bookingModal').style.display = 'none';
            document.body.style.overflow = 'auto';
            bookingState = { serviceId: null, date: '', startAt: null, endAt: null };
            document.getElementById('bookDate').value = '';
            document.getElementById('slotContainer').style.display = 'none';
        }
        function preselectBooking(serviceId) {
            document.getElementById('bookService').value = serviceId;
            openBooking();
            nextStep(2);
        }

        function updateIndicators(step) {
            const dots = document.querySelectorAll('.step-dot');
            dots.forEach((dot, idx) => {
                if (idx < step) dot.classList.add('active');
                else dot.classList.remove('active');
            });
        }

        function nextStep(step) {
            if (step === 2) {
                const sId = document.getElementById('bookService').value;
                if (!sId) { alert("Please select a service."); return; }
                bookingState.serviceId = sId;
                bookingState.serviceName = document.getElementById('bookService').options[document.getElementById('bookService').selectedIndex].text;
            }
            if (step === 3) {
                if (!bookingState.startAt) { alert("Please select a valid time slot."); return; }
            }
            if (step === 4) {
                const name = document.getElementById('patientName').value;
                const phone = document.getElementById('patientPhone').value;
                if (!name || !phone) { alert("Name and phone number are required."); return; }
                
                // Populating review screen
                document.getElementById('reviewService').innerText = bookingState.serviceName;
                document.getElementById('reviewDateTime').innerText = bookingState.date + ' at ' + bookingState.timeLabel;
                document.getElementById('reviewName').innerText = name;
                document.getElementById('reviewPhone').innerText = phone;
            }

            document.querySelectorAll('.booking-step').forEach(el => el.classList.remove('active'));
            document.getElementById('step' + step).classList.add('active');
            updateIndicators(step);
        }

        async function fetchSlots() {
            const date = document.getElementById('bookDate').value;
            const serviceId = bookingState.serviceId;
            if (!date || !serviceId) return;

            bookingState.date = date;
            bookingState.startAt = null;
            document.getElementById('btnStep2Next').disabled = true;

            const grid = document.getElementById('slotsGrid');
            const container = document.getElementById('slotContainer');
            const loader = document.getElementById('slotLoading');
            
            container.style.display = 'none';
            loader.style.display = 'block';

            try {
                const res = await fetch(\`/api/slots?date=\${date}&serviceId=\${serviceId}\`);
                const slots = await res.json();
                
                grid.innerHTML = '';
                if (slots.length === 0) {
                    grid.innerHTML = '<p class="text-muted" style="grid-column: 1/-1;">No available slots on this date.</p>';
                } else {
                    slots.forEach(slot => {
                        const btn = document.createElement('button');
                        btn.className = 'slot-btn';
                        btn.innerText = slot.timeLabel;
                        btn.onclick = () => selectSlot(btn, slot);
                        grid.appendChild(btn);
                    });
                }
                loader.style.display = 'none';
                container.style.display = 'block';
            } catch (err) {
                loader.innerText = "Error loading availability.";
            }
        }

        function selectSlot(btnElement, slotData) {
            document.querySelectorAll('.slot-btn').forEach(b => b.classList.remove('selected'));
            btnElement.classList.add('selected');
            bookingState.startAt = slotData.startAt;
            bookingState.endAt = slotData.endAt;
            bookingState.timeLabel = slotData.timeLabel;
            document.getElementById('btnStep2Next').disabled = false;
        }

        async function submitBooking() {
            const btn = document.getElementById('submitBookingBtn');
            const errDiv = document.getElementById('bookingError');
            btn.disabled = true;
            btn.innerText = "Processing...";
            errDiv.innerText = "";

            const payload = {
                patientName: document.getElementById('patientName').value,
                patientPhone: document.getElementById('patientPhone').value,
                patientEmail: document.getElementById('patientEmail').value,
                notes: document.getElementById('patientNotes').value,
                serviceId: bookingState.serviceId,
                startAt: bookingState.startAt,
                endAt: bookingState.endAt
            };

            try {
                const res = await fetch('/api/book', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const data = await res.json();

                if (data.success) {
                    document.getElementById('successRef').innerText = data.bookingReference;
                    document.querySelectorAll('.booking-step').forEach(el => el.classList.remove('active'));
                    document.getElementById('stepSuccess').classList.add('active');
                    document.getElementById('stepIndicator').style.display = 'none';
                } else {
                    errDiv.innerText = data.error || "Booking failed. Please try again.";
                    btn.disabled = false;
                    btn.innerText = "Confirm Booking";
                }
            } catch (err) {
                errDiv.innerText = "Network error. Please try again.";
                btn.disabled = false;
                btn.innerText = "Confirm Booking";
            }
        }

        // Init
        loadData();
    </script>
</body>
</html>
    `);
});

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;