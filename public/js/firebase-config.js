// Import the functions you need from the SDKs you need
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-storage.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-analytics.js";

// TODO: Replace with your actual Firebase project configuration
const firebaseConfig = {
  apiKey: "AIzaSyD4pj3Ibbr09-oVBOF9-LSJwIStQsNuC40",
  authDomain: "sustaibite.firebaseapp.com",
  projectId: "sustaibite",
  storageBucket: "sustaibite.firebasestorage.app",
  messagingSenderId: "1082100331993",
  appId: "1:1082100331993:web:29d7015c91cf276acf15c8",
  measurementId: "G-49GY8MGKHX"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);
const analytics = getAnalytics(app);

export const googleMapsApiKey = ""; // Add your Google Maps API key here if needed

export { auth, db, storage, analytics };
