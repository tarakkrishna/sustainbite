/**
 * SustainaBite - Core Frontend Orchestrator
 */

import { auth, db, storage, googleMapsApiKey } from "./firebase-config.js";
import { signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged, GoogleAuthProvider, signInWithPopup } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-auth.js";
import { collection, doc, setDoc, getDoc, getDocs, addDoc, updateDoc, onSnapshot, query, where, orderBy } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js";
import { ref, uploadBytesResumable, getDownloadURL } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-storage.js";

// State Variables
let token = localStorage.getItem("sb_token") || null;
let currentUser = localStorage.getItem("sb_user") ? JSON.parse(localStorage.getItem("sb_user")) : null;
let ws = null;

let listings = [];
let activeDelivery = null; // Currently tracked delivery for map
let driverMarker = null; // Mock coordinates of driver {lat, lng, status}

// Map Configuration
const MAP_LAT_CENTER = 12.9716;
const MAP_LNG_CENTER = 77.5946;
const MAP_ZOOM_FACTOR = 40000; // Scaling for canvas placement

// Google Maps State
let googleMapsLoaded = false;
let mainGoogleMap = null;
let regGoogleMap = null;
let regMarker = null;
let postGoogleMap = null;
let postMarker = null;
let modalGoogleMap = null;
let modalMarker = null;
let mainMarkers = [];
let mainPolyline = null;

// Initialize Application
document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  setupEventListeners();
  initRouting();
  setupFirebaseAuthListener();
  initGoogleMapsLoader();
  fetchInitialData();
});

// ==========================================
// THEME & ROUTING SERVICE
// ==========================================

function initTheme() {
  const currentTheme = localStorage.getItem("sb_theme") || "dark";
  document.documentElement.setAttribute("data-theme", currentTheme);
  
  const themeToggle = document.getElementById("theme-toggle");
  const sunIcon = document.getElementById("theme-icon-light");
  const moonIcon = document.getElementById("theme-icon-dark");

  if (currentTheme === "dark") {
    sunIcon.classList.add("hide");
    moonIcon.classList.remove("hide");
  } else {
    sunIcon.classList.remove("hide");
    moonIcon.classList.add("hide");
  }

  themeToggle.addEventListener("click", () => {
    const nextTheme = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", nextTheme);
    localStorage.setItem("sb_theme", nextTheme);
    
    sunIcon.classList.toggle("hide");
    moonIcon.classList.toggle("hide");
  });
}

function initRouting() {
  const navItems = document.querySelectorAll(".nav-item");
  navItems.forEach(item => {
    item.addEventListener("click", (e) => {
      e.preventDefault();
      const view = item.getAttribute("data-view");
      navigateTo(view);
    });
  });

  document.getElementById("logo-btn").addEventListener("click", (e) => {
    e.preventDefault();
    navigateTo("browse");
  });

  // Check initial login state
  updateAuthUI();
}

window.navigateTo = navigateTo;
function navigateTo(view) {
  // Enforce auth restrictions
  if ((view === "post" || view === "dashboard" || view === "admin") && !token) {
    showToast("Authentication Required", "Please sign in to access this portal.", "error");
    view = "auth";
  }

  // Update navbar active state
  document.querySelectorAll(".nav-item").forEach(item => {
    if (item.getAttribute("data-view") === view) {
      item.classList.add("active");
    } else {
      item.classList.remove("active");
    }
  });

  // Toggle active views
  document.querySelectorAll(".view-section").forEach(section => {
    if (section.id === `view-${view}`) {
      section.classList.add("active");
    } else {
      section.classList.remove("active");
    }
  });

  // Trigger page-specific loads
  if (view === "browse") {
    renderListings();
  } else if (view === "dashboard") {
    loadDashboardPortal();
  } else if (view === "admin") {
    loadAdminPortal();
  } else if (view === "leaderboard") {
    loadLeaderboardData();
  }

  // Auto hide/show hero banner
  const heroBanner = document.getElementById("hero-banner");
  if (view === "browse" || view === "leaderboard") {
    heroBanner.classList.remove("hide");
  } else {
    heroBanner.classList.add("hide");
  }
}
// ==========================================
// FIREBASE AUTH & LIVE LISTENERS
// ==========================================

let unsubUser = null;

function setupFirebaseAuthListener() {
  onAuthStateChanged(auth, async (user) => {
    if (unsubUser) {
      unsubUser();
      unsubUser = null;
    }
    
    if (user) {
      token = await user.getIdToken();
      localStorage.setItem("sb_token", token);
      
      unsubUser = onSnapshot(doc(db, "users", user.uid), async (userDoc) => {
        try {
          if (userDoc.exists()) {
            currentUser = { uid: user.uid, ...userDoc.data() };
            localStorage.setItem("sb_user", JSON.stringify(currentUser));
            updateAuthUI();
            setupFirestoreListeners();
            
            // Clear "Fetching user profile..." toast if present
            const toasts = document.querySelectorAll('.toast');
            toasts.forEach(t => {
              if (t.innerHTML.includes("Fetching user profile")) t.remove();
            });
            
            // Navigate to browse or dashboard if on auth screen
            const authSection = document.getElementById("view-auth");
            if (authSection && authSection.classList.contains("active")) {
              navigateTo("browse");
            }
          } else {
            console.warn("User profile not found. Showing role selection modal...");
            document.getElementById("role-selection-modal").classList.add("active");
          }
        } catch (fatalError) {
          showToast("Auth Critical Error", fatalError.message + " at " + fatalError.stack, "error");
          console.error(fatalError);
        }
      });
    } else {
      token = null;
      currentUser = null;
      localStorage.removeItem("sb_token");
      localStorage.removeItem("sb_user");
      updateAuthUI();
      setupFirestoreListeners();
    }
  });
}

let unsubDonations = null;
let unsubNotifications = null;

function setupFirestoreListeners() {
  const qDonations = query(collection(db, "donations"), where("status", "==", "Available"));
  if (unsubDonations) unsubDonations();
  unsubDonations = onSnapshot(qDonations, (snapshot) => {
    listings = snapshot.docs.map(doc => {
      const data = doc.data();
      const item = { id: doc.id, ...data };
      checkAndUpdateExpiry(item); // Passive expiration check
      
      let dist = 0;
      if (currentUser && currentUser.lat && currentUser.lng) {
        dist = calculateDistance(currentUser.lat, currentUser.lng, data.lat, data.lng);
      } else {
        dist = calculateDistance(MAP_LAT_CENTER, MAP_LNG_CENTER, data.lat, data.lng);
      }
      data.distance = parseFloat(dist.toFixed(1));
      return { id: doc.id, ...data };
    });
    renderListings();
    if (googleMapsLoaded && typeof updateRadarMap === 'function') updateRadarMap();
  });

  // Notifications Listener (Only for logged in users, primarily NGOs)
  if (currentUser) {
    if (unsubNotifications) unsubNotifications();
    const qNotifs = query(collection(db, "notifications"), where("recipientId", "==", currentUser.uid), where("read", "==", false));
    unsubNotifications = onSnapshot(qNotifs, (snapshot) => {
      const notifs = [];
      snapshot.forEach(doc => {
        notifs.push({ id: doc.id, ...doc.data() });
      });
      
      // Sort by descending createdAt
      notifs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      
      updateNotificationUI(notifs);
    });
  }
}

// Update Notification UI
function updateNotificationUI(notifs) {
  const badge = document.getElementById("notif-badge");
  const listContainer = document.getElementById("notif-list");
  
  if (!badge || !listContainer) return;

  if (notifs.length > 0) {
    badge.style.display = "block";
    badge.textContent = notifs.length;
    listContainer.innerHTML = "";
    notifs.forEach(notif => {
      listContainer.innerHTML += `
        <div class="notif-item" style="padding: 10px; background: rgba(255,255,255,0.05); border-radius: var(--radius-sm); border-left: 3px solid var(--primary); cursor: pointer;" onclick="markNotificationRead('${notif.id}')">
          <strong style="display: block; font-size: 0.9rem; color: var(--primary); margin-bottom: 4px;">${notif.title}</strong>
          <span style="font-size: 0.8rem; color: var(--text-secondary);">${notif.message}</span>
          <div style="font-size: 0.7rem; color: var(--text-muted); margin-top: 6px; text-align: right;">${new Date(notif.createdAt).toLocaleTimeString()}</div>
        </div>
      `;
    });
  } else {
    badge.style.display = "none";
    listContainer.innerHTML = `<div style="text-align: center; color: var(--text-secondary); font-size: 0.85rem; padding: 20px 0;">No new notifications</div>`;
  }
}

window.markNotificationRead = async function(notifId) {
  try {
    await updateDoc(doc(db, "notifications", notifId), {
      read: true
    });
  } catch (error) {
    console.error("Error marking notification read:", error);
  }
}


// Haversine formula for distance in km
function calculateDistance(lat1, lon1, lat2, lon2) {
  if (!lat1 || !lon1 || !lat2 || !lon2) return 0;
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}
// ==========================================
// REST SERVICES (API CONSUMPTION)
// ==========================================

async function fetchInitialData() {
  loadGlobalStats();
}

let unsubGlobalStats = null;
async function loadGlobalStats() {
  try {
    if (unsubGlobalStats) unsubGlobalStats();
    
    // Listen to all completed or claimed donations to calculate global impact
    const qGlobal = query(collection(db, "donations"), where("status", "in", ["Completed", "Claimed", "Assigned", "Approved", "InTransit", "Requested"]));
    
    unsubGlobalStats = onSnapshot(qGlobal, (snapshot) => {
      let totalMeals = 0;
      let totalRescues = 0;
      
      snapshot.forEach(doc => {
        const data = doc.data();
        if (["Completed", "Claimed", "Assigned", "InTransit"].includes(data.status)) {
          totalMeals += parseInt(data.servings) || 0;
          totalRescues += 1;
        }
      });
      
      const totalCo2 = (totalMeals * 0.5).toFixed(1); // 0.5kg CO2 per meal roughly
      
      document.getElementById("global-stat-meals").textContent = totalMeals;
      document.getElementById("global-stat-co2").textContent = totalCo2;
      document.getElementById("global-stat-rescues").textContent = totalRescues;
    });
  } catch (error) {
    console.error("Failed to load global counter stats:", error);
  }
}

// ==========================================
// AUTHENTICATION INTERACTION
// ==========================================

function updateAuthUI() {
  const authActions = document.getElementById("auth-actions");
  const userProfile = document.getElementById("user-profile");
  const navPostLi = document.getElementById("nav-post-li");
  const navDashLi = document.getElementById("nav-dash-li");
  const navAdminLi = document.getElementById("nav-admin-li");

  if (token && currentUser) {
    // Logged In state
    authActions.classList.add("hide");
    userProfile.classList.remove("hide");
    document.getElementById("user-display-name").textContent = currentUser.name;
    
    // Set avatars
    const avatarIcon = document.getElementById("user-avatar-icon");
    avatarIcon.className = "fa-solid";
    if (currentUser.role === "ngo") avatarIcon.classList.add("fa-hand-holding-heart");
    else if (currentUser.role === "admin") avatarIcon.classList.add("fa-user-shield");
    else avatarIcon.classList.add("fa-store");

    // Dynamic nav tabs based on role
    navDashLi.classList.remove("hide");
    if (currentUser.role === "donor" || currentUser.role === "admin") {
      navPostLi.classList.remove("hide");
    } else {
      navPostLi.classList.add("hide");
    }
    
    if (currentUser.role === "admin") {
      navAdminLi.classList.remove("hide");
    } else {
      navAdminLi.classList.add("hide");
    }

    // Notifications display logic
    const notifBell = document.getElementById("nav-notifications");
    if (notifBell) {
      if (currentUser.role === "ngo") {
        notifBell.classList.remove("hide");
      } else {
        notifBell.classList.add("hide");
      }
    }
  } else {
    // Logged Out state
    authActions.classList.remove("hide");
    userProfile.classList.add("hide");
    navPostLi.classList.add("hide");
    navDashLi.classList.add("hide");
    navAdminLi.classList.add("hide");
    
    activeDelivery = null;
    driverMarker = null;
  }
}

// ==========================================
// RENDERING FEED LISTINGS
// ==========================================

function renderListings() {
  const container = document.getElementById("food-listings-container");
  container.innerHTML = "";

  const filtered = filterListingsFeed();

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="grid-column: span 3;">
        <i class="fa-solid fa-cookie-bite"></i>
        <p>No food rescues matching selected criteria. Try adjusting filters.</p>
      </div>
    `;
    drawMap();
    return;
  }

  filtered.forEach(item => {
    // Check remaining expiry time
    const expiresTime = new Date(item.expires_at).getTime();
    const nowTime = new Date().getTime();
    const durationLeftMs = expiresTime - nowTime;

    if (durationLeftMs <= 0) return; // skip expired items in feed

    const hoursLeft = durationLeftMs / (1000 * 60 * 60);
    let alertClass = "";
    let hoursStr = `${Math.floor(hoursLeft)}h ${Math.round((hoursLeft % 1) * 60)}m`;

    let timerPercentage = (hoursLeft / 5) * 100; // max scale 5 hours indicator
    if (timerPercentage > 100) timerPercentage = 100;

    if (hoursLeft <= 1) {
      alertClass = "danger";
    } else if (hoursLeft <= 2.5) {
      alertClass = "warning";
    }

    const card = document.createElement("div");
    card.className = "food-card glass";
    card.innerHTML = `
      <div class="card-img-container">
        <span class="category-badge ${item.category.toLowerCase()}">${item.category}</span>
        <span class="distance-badge"><i class="fa-solid fa-location-arrow"></i> ${item.distance} km</span>
        <span class="donor-badge">
          <i class="fa-solid ${item.donor_type === 'Restaurant' ? 'fa-store' : 'fa-house-user'}"></i>
          ${item.donor_name}
        </span>
        <img src="${item.image_url}" class="card-img" alt="${item.title}">
      </div>
      <div class="card-body">
        <h3>${item.title}</h3>
        <div class="servings-tag">
          <i class="fa-solid fa-bowl-rice"></i>
          <span>${item.servings} portions available</span>
        </div>
        
        <div class="timer-section">
          <div class="timer-label">
            <span>Freshness Window</span>
            <span style="font-weight: 700;">${hoursStr}</span>
          </div>
          <div class="timer-bar-container">
            <div class="timer-bar ${alertClass}" style="width: ${timerPercentage}%"></div>
          </div>
        </div>

        <div class="card-footer">
          <a href="https://www.google.com/maps/search/?api=1&query=${item.lat},${item.lng}" target="_blank" class="btn btn-secondary btn-sm" style="text-decoration: none;"><i class="fa-solid fa-map-marker-alt"></i> Location</a>
          <button class="btn btn-primary btn-sm" onclick="window.openDetailModal('${item.id}')">Details</button>
        </div>
      </div>
    `;
    container.appendChild(card);
  });

  drawMap();
}

function filterListingsFeed() {
  const query = document.getElementById("filter-search").value.toLowerCase();
  const category = document.getElementById("filter-category").value;
  const distance = document.getElementById("filter-distance").value;
  const portions = document.getElementById("filter-portions").value;
  const sort = document.getElementById("filter-sort").value;

  let filtered = [...listings].filter(item => item.status === "Available");

  // Email/search query
  if (query) {
    filtered = filtered.filter(l => 
      l.title.toLowerCase().includes(query) || 
      l.description.toLowerCase().includes(query) ||
      l.donor_name.toLowerCase().includes(query) ||
      l.address.toLowerCase().includes(query)
    );
  }

  // Category
  if (category !== "all") {
    filtered = filtered.filter(l => l.category.toLowerCase() === category.toLowerCase());
  }

  // Portions
  if (portions !== "all") {
    const minVal = parseInt(portions);
    filtered = filtered.filter(l => l.servings >= minVal);
  }

  // Distance mock calculations if User GPS active
  if (distance !== "all") {
    const maxDist = parseFloat(distance);
    filtered = filtered.filter(l => l.distance <= maxDist);
  }

  // Sort
  if (sort === "closest") {
    filtered.sort((a, b) => a.distance - b.distance);
  } else if (sort === "newest") {
    filtered.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  } else {
    // expiry soonest
    filtered.sort((a, b) => new Date(a.expires_at) - new Date(b.expires_at));
  }

  return filtered;
}

// ==========================================
// RADAR MAP VISUALIZER (CANVAS ROUTING ENGINE)
// ==========================================

// Google Maps Loader & Autocomplete initialization
async function initGoogleMapsLoader() {
  try {
    const apiKey = googleMapsApiKey;
    
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?${apiKey ? 'key=' + apiKey + '&' : ''}libraries=places`;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      googleMapsLoaded = true;
      console.log("🗺️ Google Maps API loaded successfully.");
      initGoogleMapsComponents();
    };
    script.onerror = () => {
      console.error("❌ Failed to load Google Maps API script.");
    };
    document.head.appendChild(script);
  } catch (e) {
    console.error("❌ Error fetching configuration for Google Maps:", e);
  }
}

function handleAddressInputForMapsUrl(e, latId, lngId, mapObj, markerObj) {
  const val = e.target ? e.target.value : e; // Allow passing raw value or event
  if (!val || val.trim() === "") {
    showToast("Error", "Please paste a Google Maps link first.", "error");
    return;
  }

  let lat = null;
  let lng = null;

  // @lat,lng
  let match = val.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (match) { lat = match[1]; lng = match[2]; }
  
  // ?q=lat,lng
  if (!match) {
    match = val.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (match) { lat = match[1]; lng = match[2]; }
  }

  // ll=lat,lng
  if (!match) {
    match = val.match(/[?&]ll=(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (match) { lat = match[1]; lng = match[2]; }
  }

  // query=lat,lng
  if (!match) {
    match = val.match(/query=(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (match) { lat = match[1]; lng = match[2]; }
  }

  // raw coordinates: 12.971, 77.594
  if (!match) {
    match = val.match(/^(-?\d+\.\d+)[,\s]+(-?\d+\.\d+)$/);
    if (match) { lat = match[1]; lng = match[2]; }
  }

  if (lat && lng) {
    document.getElementById(latId).value = parseFloat(lat).toFixed(6);
    document.getElementById(lngId).value = parseFloat(lng).toFixed(6);
    showToast("Link Parsed", "Coordinates extracted from Google Maps link.", "success");

    if (typeof mapObj !== "undefined" && mapObj) {
      mapObj.setCenter({ lat: parseFloat(lat), lng: parseFloat(lng) });
      mapObj.setZoom(15);
    }
    if (typeof markerObj !== "undefined" && markerObj) {
      markerObj.setPosition({ lat: parseFloat(lat), lng: parseFloat(lng) });
    }
  } else if (val.includes("maps.app.goo.gl") || val.includes("goo.gl/maps")) {
    showToast("Short Link Detected", "We cannot extract coordinates from shortened links. Please use the full Google Maps URL or GPS button.", "warning");
  } else {
    showToast("Parsing Failed", "Could not find coordinates in this text. Try pasting a full Google Maps link.", "error");
  }
}

function initGoogleMapsComponents() {
  if (!googleMapsLoaded) return;

  // 1. Interactive Radar Map
  const mapElement = document.getElementById("interactive-map-canvas");
  if (mapElement) {
    mapElement.innerHTML = "";
    mainGoogleMap = new google.maps.Map(mapElement, {
      center: { lat: MAP_LAT_CENTER, lng: MAP_LNG_CENTER },
      zoom: 13,
      styles: getDarkMapStyles(),
      mapTypeControl: false,
      streetViewControl: false
    });
  }

  // 2. Registration Autocomplete and Map
  const regAddressInput = document.getElementById("reg-address");
  if (regAddressInput) {
    regAddressInput.addEventListener("input", (e) => handleAddressInputForMapsUrl(e, "reg-lat", "reg-lng", regGoogleMap, regMarker));
    const regAutocomplete = new google.maps.places.Autocomplete(regAddressInput);
    regAutocomplete.addListener("place_changed", () => {
      const place = regAutocomplete.getPlace();
      if (!place.geometry || !place.geometry.location) return;
      
      const lat = place.geometry.location.lat();
      const lng = place.geometry.location.lng();
      
      document.getElementById("reg-lat").value = lat.toFixed(6);
      document.getElementById("reg-lng").value = lng.toFixed(6);
      
      if (regGoogleMap) {
        regGoogleMap.setCenter({ lat, lng });
        regGoogleMap.setZoom(15);
        if (regMarker) regMarker.setPosition({ lat, lng });
      }
    });
  }

  const regMapElement = document.getElementById("reg-map");
  if (regMapElement) {
    regGoogleMap = new google.maps.Map(regMapElement, {
      center: { lat: MAP_LAT_CENTER, lng: MAP_LNG_CENTER },
      zoom: 12,
      styles: getDarkMapStyles(),
      mapTypeControl: false,
      streetViewControl: false
    });
    
    regMarker = new google.maps.Marker({
      position: { lat: MAP_LAT_CENTER, lng: MAP_LNG_CENTER },
      map: regGoogleMap,
      draggable: true
    });

    regMarker.addListener("dragend", () => {
      const pos = regMarker.getPosition();
      document.getElementById("reg-lat").value = pos.lat().toFixed(6);
      document.getElementById("reg-lng").value = pos.lng().toFixed(6);
    });

    regGoogleMap.addListener("click", (e) => {
      regMarker.setPosition(e.latLng);
      document.getElementById("reg-lat").value = e.latLng.lat().toFixed(6);
      document.getElementById("reg-lng").value = e.latLng.lng().toFixed(6);
    });
  }

  // 3. Post Food Autocomplete and Map
  const postAddressInput = document.getElementById("post-address");
  if (postAddressInput) {
    postAddressInput.addEventListener("input", (e) => handleAddressInputForMapsUrl(e, "post-lat", "post-lng", postGoogleMap, postMarker));
    const postAutocomplete = new google.maps.places.Autocomplete(postAddressInput);
    postAutocomplete.addListener("place_changed", () => {
      const place = postAutocomplete.getPlace();
      if (!place.geometry || !place.geometry.location) return;
      
      const lat = place.geometry.location.lat();
      const lng = place.geometry.location.lng();
      
      document.getElementById("post-lat").value = lat.toFixed(6);
      document.getElementById("post-lng").value = lng.toFixed(6);
      
      if (postGoogleMap) {
        postGoogleMap.setCenter({ lat, lng });
        postGoogleMap.setZoom(15);
        if (postMarker) postMarker.setPosition({ lat, lng });
      }
    });
  }

  const postMapElement = document.getElementById("post-map");
  if (postMapElement) {
    postGoogleMap = new google.maps.Map(postMapElement, {
      center: { lat: MAP_LAT_CENTER, lng: MAP_LNG_CENTER },
      zoom: 12,
      styles: getDarkMapStyles(),
      mapTypeControl: false,
      streetViewControl: false
    });
    
    postMarker = new google.maps.Marker({
      position: { lat: MAP_LAT_CENTER, lng: MAP_LNG_CENTER },
      map: postGoogleMap,
      draggable: true
    });

    postMarker.addListener("dragend", () => {
      const pos = postMarker.getPosition();
      document.getElementById("post-lat").value = pos.lat().toFixed(6);
      document.getElementById("post-lng").value = pos.lng().toFixed(6);
    });

    postGoogleMap.addListener("click", (e) => {
      postMarker.setPosition(e.latLng);
      document.getElementById("post-lat").value = e.latLng.lat().toFixed(6);
      document.getElementById("post-lng").value = e.latLng.lng().toFixed(6);
    });
  }
}

function getDarkMapStyles() {
  return [
    { elementType: "geometry", stylers: [{ color: "#1e293b" }] },
    { elementType: "labels.text.stroke", stylers: [{ color: "#1e293b" }] },
    { elementType: "labels.text.fill", stylers: [{ color: "#747f8d" }] },
    {
      featureType: "administrative.locality",
      elementType: "labels.text.fill",
      stylers: [{ color: "#cbd5e1" }]
    },
    {
      featureType: "poi",
      elementType: "labels.text.fill",
      stylers: [{ color: "#cbd5e1" }]
    },
    {
      featureType: "poi.park",
      elementType: "geometry",
      stylers: [{ color: "#0f172a" }]
    },
    {
      featureType: "poi.park",
      elementType: "labels.text.fill",
      stylers: [{ color: "#64748b" }]
    },
    {
      featureType: "road",
      elementType: "geometry",
      stylers: [{ color: "#334155" }]
    },
    {
      featureType: "road",
      elementType: "geometry.stroke",
      stylers: [{ color: "#1e293b" }]
    },
    {
      featureType: "road",
      elementType: "labels.text.fill",
      stylers: [{ color: "#94a3b8" }]
    },
    {
      featureType: "road.highway",
      elementType: "geometry",
      stylers: [{ color: "#475569" }]
    },
    {
      featureType: "road.highway",
      elementType: "geometry.stroke",
      stylers: [{ color: "#1e293b" }]
    },
    {
      featureType: "road.highway",
      elementType: "labels.text.fill",
      stylers: [{ color: "#cbd5e1" }]
    },
    {
      featureType: "transit",
      elementType: "geometry",
      stylers: [{ color: "#1e293b" }]
    },
    {
      featureType: "transit.station",
      elementType: "labels.text.fill",
      stylers: [{ color: "#cbd5e1" }]
    },
    {
      featureType: "water",
      elementType: "geometry",
      stylers: [{ color: "#0f172a" }]
    },
    {
      featureType: "water",
      elementType: "labels.text.fill",
      stylers: [{ color: "#475569" }]
    },
    {
      featureType: "water",
      elementType: "labels.text.stroke",
      stylers: [{ color: "#0f172a" }]
    }
  ];
}

function drawMap() {
  const mapElement = document.getElementById("interactive-map-canvas");
  if (!mapElement) return;

  // Fallback to Canvas logic if Google Maps is not loaded
  if (!googleMapsLoaded || !mainGoogleMap) {
    drawCanvasMapFallback();
    return;
  }

  // Clear existing Google Maps markers and polylines
  mainMarkers.forEach(m => m.setMap(null));
  mainMarkers = [];
  if (mainPolyline) {
    mainPolyline.setMap(null);
    mainPolyline = null;
  }

  const activeFeed = filterListingsFeed();

  // 1. Plot Available Listings (Donors)
  activeFeed.forEach(item => {
    const lat = parseFloat(item.lat);
    const lng = parseFloat(item.lng);
    
    let iconUrl = "https://maps.google.com/mapfiles/ms/icons/green-dot.png";
    if (item.category === "Non-Veg") iconUrl = "https://maps.google.com/mapfiles/ms/icons/red-dot.png";
    else if (item.category === "Vegan") iconUrl = "https://maps.google.com/mapfiles/ms/icons/yellow-dot.png";

    const marker = new google.maps.Marker({
      position: { lat, lng },
      map: mainGoogleMap,
      title: `${item.donor_name}: ${item.title}`,
      icon: iconUrl
    });

    marker.addListener("click", () => {
      showMapPopup(item);
    });

    mainMarkers.push(marker);
  });

  // 2. Plot NGO User
  if (currentUser && currentUser.role === "ngo") {
    const lat = parseFloat(currentUser.lat);
    const lng = parseFloat(currentUser.lng);

    const marker = new google.maps.Marker({
      position: { lat, lng },
      map: mainGoogleMap,
      title: currentUser.name,
      icon: "https://maps.google.com/mapfiles/ms/icons/blue-dot.png"
    });

    mainMarkers.push(marker);
  }

  // 3. Draw active delivery routing and transit animation
  if (activeDelivery) {
    const donLat = parseFloat(activeDelivery.donor_lat);
    const donLng = parseFloat(activeDelivery.donor_lng);
    const ngoLat = parseFloat(activeDelivery.ngo_lat);
    const ngoLng = parseFloat(activeDelivery.ngo_lng);

    const donorMarker = new google.maps.Marker({
      position: { lat: donLat, lng: donLng },
      map: mainGoogleMap,
      title: `Donor: ${activeDelivery.donor_name}`,
      icon: "https://maps.google.com/mapfiles/ms/icons/green-dot.png"
    });
    mainMarkers.push(donorMarker);

    const ngoMarker = new google.maps.Marker({
      position: { lat: ngoLat, lng: ngoLng },
      map: mainGoogleMap,
      title: `NGO: ${activeDelivery.ngo_name}`,
      icon: "https://maps.google.com/mapfiles/ms/icons/blue-dot.png"
    });
    mainMarkers.push(ngoMarker);

    mainPolyline = new google.maps.Polyline({
      path: [
        { lat: donLat, lng: donLng },
        { lat: ngoLat, lng: ngoLng }
      ],
      geodesic: true,
      strokeColor: "#10b981",
      strokeOpacity: 0.6,
      strokeWeight: 4,
      map: mainGoogleMap
    });

    if (driverMarker) {
      const dMarker = new google.maps.Marker({
        position: { lat: parseFloat(driverMarker.lat), lng: parseFloat(driverMarker.lng) },
        map: mainGoogleMap,
        title: `Driver (${activeDelivery.vehicle_type}): ${activeDelivery.driver_name || 'Simulated Rider'}`,
        icon: "https://maps.google.com/mapfiles/ms/icons/purple-dot.png"
      });
      mainMarkers.push(dMarker);

      const bounds = new google.maps.LatLngBounds();
      bounds.extend({ lat: donLat, lng: donLng });
      bounds.extend({ lat: ngoLat, lng: ngoLng });
      bounds.extend({ lat: parseFloat(driverMarker.lat), lng: parseFloat(driverMarker.lng) });
      mainGoogleMap.fitBounds(bounds);
    } else {
      const bounds = new google.maps.LatLngBounds();
      bounds.extend({ lat: donLat, lng: donLng });
      bounds.extend({ lat: ngoLat, lng: ngoLng });
      mainGoogleMap.fitBounds(bounds);
    }
  } else if (activeFeed.length > 0) {
    const bounds = new google.maps.LatLngBounds();
    activeFeed.forEach(item => {
      bounds.extend({ lat: parseFloat(item.lat), lng: parseFloat(item.lng) });
    });
    if (currentUser) {
      bounds.extend({ lat: parseFloat(currentUser.lat), lng: parseFloat(currentUser.lng) });
    }
    mainGoogleMap.fitBounds(bounds);
  } else {
    mainGoogleMap.setCenter({ lat: MAP_LAT_CENTER, lng: MAP_LNG_CENTER });
    mainGoogleMap.setZoom(12);
  }
}

function drawCanvasMapFallback() {
  const mapContainer = document.getElementById("interactive-map-canvas");
  if (!mapContainer) return;

  // Clear existing pins
  const existingPins = mapContainer.querySelectorAll(".map-pin");
  existingPins.forEach(p => p.remove());

  // Clear existing canvas overlays
  const existingCanvas = mapContainer.querySelector(".map-routing-canvas");
  if (existingCanvas) existingCanvas.remove();

  // Create routing path canvas overlay
  const canvas = document.createElement("canvas");
  canvas.className = "map-routing-canvas";
  mapContainer.appendChild(canvas);

  const rect = mapContainer.getBoundingClientRect();
  canvas.width = rect.width || 400;
  canvas.height = rect.height || 500;
  const ctx = canvas.getContext("2d");

  // Determine which listings to plot on map
  const activeFeed = filterListingsFeed();

  // Plot Hotel / Donor listings
  activeFeed.forEach(item => {
    const coords = getCanvasCoords(parseFloat(item.lat), parseFloat(item.lng), canvas.width, canvas.height);
    
    const pin = document.createElement("div");
    pin.className = `map-pin hotel ${item.category.toLowerCase()}`;
    pin.style.left = `${coords.x}px`;
    pin.style.top = `${coords.y}px`;
    pin.innerHTML = `<i class="fa-solid fa-store"></i>`;
    pin.title = `${item.donor_name}: ${item.title}`;
    
    pin.addEventListener("click", () => {
      showMapPopup(item);
    });

    mapContainer.appendChild(pin);
  });

  // Plot NGO User
  if (currentUser && currentUser.role === "ngo") {
    const ngoCoords = getCanvasCoords(parseFloat(currentUser.lat), parseFloat(currentUser.lng), canvas.width, canvas.height);
    const pin = document.createElement("div");
    pin.className = "map-pin ngo";
    pin.style.left = `${ngoCoords.x}px`;
    pin.style.top = `${ngoCoords.y}px`;
    pin.innerHTML = `<i class="fa-solid fa-hand-holding-heart"></i>`;
    pin.title = currentUser.name;
    mapContainer.appendChild(pin);
  }

  // Draw Live transit paths
  if (activeDelivery) {
    const donLat = parseFloat(activeDelivery.donor_lat);
    const donLng = parseFloat(activeDelivery.donor_lng);
    const ngoLat = parseFloat(activeDelivery.ngo_lat);
    const ngoLng = parseFloat(activeDelivery.ngo_lng);

    const donCoords = getCanvasCoords(donLat, donLng, canvas.width, canvas.height);
    const ngoCoords = getCanvasCoords(ngoLat, ngoLng, canvas.width, canvas.height);

    // Plot donor point
    const donorPin = document.createElement("div");
    donorPin.className = "map-pin hotel";
    donorPin.style.left = `${donCoords.x}px`;
    donorPin.style.top = `${donCoords.y}px`;
    donorPin.innerHTML = `<i class="fa-solid fa-store"></i>`;
    mapContainer.appendChild(donorPin);

    // Plot NGO point
    const ngoPin = document.createElement("div");
    ngoPin.className = "map-pin ngo";
    ngoPin.style.left = `${ngoCoords.x}px`;
    ngoPin.style.top = `${ngoCoords.y}px`;
    ngoPin.innerHTML = `<i class="fa-solid fa-hand-holding-heart"></i>`;
    mapContainer.appendChild(ngoPin);

    // Connect Path: Hotel -> NGO
    ctx.beginPath();
    ctx.moveTo(donCoords.x, donCoords.y);
    ctx.lineTo(ngoCoords.x, ngoCoords.y);
    ctx.strokeStyle = "rgba(52, 211, 153, 0.4)";
    ctx.lineWidth = 4;
    ctx.setLineDash([8, 8]);
    ctx.stroke();

    // Plot Driver if coordinates received
    if (driverMarker) {
      const driverCoords = getCanvasCoords(driverMarker.lat, driverMarker.lng, canvas.width, canvas.height);
      const dPin = document.createElement("div");
      dPin.className = "map-pin driver";
      dPin.style.left = `${driverCoords.x}px`;
      dPin.style.top = `${driverCoords.y}px`;
      
      const vehicleIcon = activeDelivery.vehicle_type === "RapidoBike" ? "fa-motorcycle" : (activeDelivery.vehicle_type === "PorterMiniTruck" ? "fa-truck" : "fa-car");
      dPin.innerHTML = `<i class="fa-solid ${vehicleIcon}"></i>`;
      mapContainer.appendChild(dPin);

      // Connect Driver -> Destination
      ctx.beginPath();
      ctx.moveTo(driverCoords.x, driverCoords.y);
      if (driverMarker.status === "EnRouteToPickup") {
        ctx.lineTo(donCoords.x, donCoords.y);
        ctx.strokeStyle = "rgba(251, 191, 36, 0.6)";
      } else {
        ctx.lineTo(ngoCoords.x, ngoCoords.y);
        ctx.strokeStyle = "rgba(52, 211, 153, 0.7)";
      }
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  }
}

// Convert Lat/Lng coordinates into visual Canvas pixels
function getCanvasCoords(lat, lng, width, height) {
  // Center coordinates scaling offset mapping
  const x = (lng - MAP_LNG_CENTER) * MAP_ZOOM_FACTOR + (width / 2);
  // Lat values increase upwards in standard grid, pixels increase downwards
  const y = (MAP_LAT_CENTER - lat) * MAP_ZOOM_FACTOR + (height / 2);
  
  // Bound check to keep pins inside view boundaries
  const paddedX = Math.max(15, Math.min(width - 15, x));
  const paddedY = Math.max(15, Math.min(height - 15, y));

  return { x: paddedX, y: paddedY };
}

function showMapPopup(item) {
  const card = document.getElementById("map-popup-card");
  card.className = "map-popup glass active";
  card.innerHTML = `
    <img src="${item.image_url}" class="popup-img" alt="${item.title}">
    <div class="popup-content">
      <h4>${item.title}</h4>
      <p class="popup-desc">${item.description}</p>
      <div class="popup-meta">
        <span>${item.servings} portions</span>
        <button class="btn btn-primary" style="padding: 4px 10px; font-size:0.75rem;" onclick="window.openDetailModal('${item.id}')">RescuEat</button>
      </div>
    </div>
  `;
}

// ==========================================
// PORTAL LOADERS & DASHBOARDS
// ==========================================

async function loadDashboardPortal() {
  if (!token) return;

  const panelNGO = document.getElementById("panel-ngo-claims");
  const panelDonor = document.getElementById("panel-donor-postings");
  
  // Reset portals visibility
  panelNGO.classList.add("hide");
  panelDonor.classList.add("hide");

  const heading = document.getElementById("dashboard-heading");
  heading.textContent = `${currentUser.name} Portal`;

  // Fetch Personal Metrics
  fetchPersonalStats();
  fetchHistoryLogs();

  // Load appropriate panels
  if (currentUser.role === "ngo") {
    panelNGO.classList.remove("hide");
    loadNgoActiveClaims();
  } else if (currentUser.role === "donor") {
    panelDonor.classList.remove("hide");
    loadDonorActivePostings();
  }
}

let unsubPersonalStats = null;
async function fetchPersonalStats() {
  try {
    if (!currentUser) return;
    if (unsubPersonalStats) unsubPersonalStats();
    
    let fieldToMatch = "donor_id";
    if (currentUser.role === "ngo") fieldToMatch = "ngo_id";
    
    // For personal stats, we count what they successfully claimed or donated
    const qPersonal = query(collection(db, "donations"), where(fieldToMatch, "==", currentUser.uid), where("status", "in", ["Completed", "Claimed", "Assigned", "InTransit"]));
    
    unsubPersonalStats = onSnapshot(qPersonal, (snapshot) => {
      let totalMeals = 0;
      let totalRescues = 0;
      
      snapshot.forEach(doc => {
        const data = doc.data();
        totalMeals += parseInt(data.servings) || 0;
        totalRescues += 1;
      });
      
      const totalCo2 = parseFloat((totalMeals * 0.5).toFixed(1));
      
      document.getElementById("dash-stat-meals").textContent = totalMeals;
      document.getElementById("dash-stat-co2").textContent = totalCo2;
      document.getElementById("dash-stat-rescues").textContent = totalRescues;
      
      // Equivalents calculations
      document.getElementById("eq-val-miles").textContent = Math.round(totalCo2 * 2.5);
      document.getElementById("eq-val-water").textContent = `${totalMeals * 100}L`;
    });
  } catch (error) {
    console.error("Personal stats loading failed:", error);
  }
}

async function checkAndUpdateExpiry(item) {
  const expiresTime = new Date(item.expires_at).getTime();
  const nowTime = new Date().getTime();
  
  if (nowTime > expiresTime && !["Completed", "Cancelled", "Expired"].includes(item.status)) {
    try {
      await updateDoc(doc(db, "donations", item.id), { status: "Expired" });
      item.status = "Expired";
      return true;
    } catch (e) {
      console.error("Failed to expire document", e);
    }
  }
  return false;
}

async function fetchHistoryLogs() {
  try {
    let historyDocs = [];
    
    if (currentUser.role === "donor") {
      const q = query(collection(db, "donations"), where("donor_id", "==", currentUser.uid), where("status", "in", ["Completed", "Expired", "Cancelled"]));
      const snap = await getDocs(q);
      snap.forEach(d => historyDocs.push({ id: d.id, ...d.data() }));
    } else if (currentUser.role === "ngo") {
      const q1 = query(collection(db, "donations"), where("requested_by", "==", currentUser.uid), where("status", "in", ["Completed", "Expired", "Cancelled"]));
      const snap1 = await getDocs(q1);
      snap1.forEach(d => historyDocs.push({ id: d.id, ...d.data() }));
      
      const q2 = query(collection(db, "donations"), where("ngo_id", "==", currentUser.uid), where("status", "in", ["Completed", "Expired", "Cancelled"]));
      const snap2 = await getDocs(q2);
      snap2.forEach(d => {
        if (!historyDocs.find(x => x.id === d.id)) {
          historyDocs.push({ id: d.id, ...d.data() });
        }
      });
    }

    historyDocs.sort((a, b) => {
      const timeA = a.completed_at ? new Date(a.completed_at).getTime() : new Date(a.created_at).getTime();
      const timeB = b.completed_at ? new Date(b.completed_at).getTime() : new Date(b.created_at).getTime();
      return timeB - timeA;
    });

    const container = document.getElementById("user-history-list");
    container.innerHTML = "";

    if (historyDocs.length === 0) {
      container.innerHTML = `<div class="empty-state"><i class="fa-solid fa-history"></i><p>No completed or expired rescues in your history ledger.</p></div>`;
      return;
    }

    historyDocs.forEach(h => {
      let relativeUser = currentUser.role === "ngo" ? `from ${h.donor_name}` : `by ${h.ngo_name || h.requested_by_name || 'N/A'}`;
      let badgeClass = h.status === "Completed" ? "completed" : (h.status === "Expired" ? "danger" : "warning");
      let displayStatus = h.status === "Completed" ? "Delivered" : h.status;

      const item = document.createElement("div");
      item.className = "dash-item";
      item.innerHTML = `
        <div class="dash-item-info">
          <img src="${h.image_url}" class="dash-item-img" alt="">
          <div class="dash-item-text">
            <h4>${h.title}</h4>
            <div class="dash-item-meta">
              <span><i class="fa-solid fa-calendar-check"></i> ${h.status === "Completed" ? "Completed" : "Logged"} ${new Date(h.completed_at || h.created_at).toLocaleDateString()}</span>
              <span>Rescued: <strong>${h.servings} portions</strong></span>
              <span>Partner: ${relativeUser}</span>
            </div>
          </div>
        </div>
        <span class="status-badge ${badgeClass}">${displayStatus}</span>
      `;
      container.appendChild(item);
    });
  } catch (error) {
    console.error("Failed to load history list:", error);
  }
}

// --- NGO ACTIVE CLAIMS LOAD ---
async function loadNgoActiveClaims() {
  try {
    const qReq = query(collection(db, "donations"), where("requested_by", "==", currentUser.uid), where("status", "==", "Requested"));
    const snapReq = await getDocs(qReq);
    
    const qClaims = query(collection(db, "claims"), where("ngo_id", "==", currentUser.uid), where("status", "==", "Active"));
    const snapClaims = await getDocs(qClaims);
    
    let deliveries = [];

    // 1. Add Requested items
    for (let docSnap of snapReq.docs) {
      const donation = docSnap.data();
      const item = { id: docSnap.id, ...donation };
      checkAndUpdateExpiry(item); // Lazy expiration
      if (item.status === "Expired") continue;

      deliveries.push({
        type: "request",
        listing_id: docSnap.id,
        title: donation.title,
        donor_name: donation.donor_name,
        donor_contact: donation.donor_contact,
        pickup_address: donation.address,
        status: "Requested",
        image_url: donation.image_url,
        servings: donation.servings
      });
    }

    // 2. Add Approved / Claimed items (from claims)
    for (let cDoc of snapClaims.docs) {
      const claim = cDoc.data();
      const qDel = query(collection(db, "deliveries"), where("claim_id", "==", cDoc.id));
      const snapDel = await getDocs(qDel);
      
      const donSnap = await getDoc(doc(db, "donations", claim.donation_id));
      const donation = donSnap.data();
      const item = { id: donSnap.id, ...donation };
      checkAndUpdateExpiry(item);
      if (item.status === "Expired") continue;

      snapDel.forEach(dDoc => {
        let d = dDoc.data();
        deliveries.push({
          type: "delivery",
          id: dDoc.id,
          listing_id: claim.donation_id,
          title: donation.title,
          donor_name: donation.donor_name,
          donor_contact: donation.donor_contact,
          pickup_address: donation.address,
          status: d.status, // Assigned, InTransit, etc
          donation_status: donation.status, // Approved, Claimed
          vehicle_type: d.vehicle_type,
          vehicle_plate: d.vehicle_plate,
          driver_name: d.driver_name,
          driver_phone: d.driver_phone,
          image_url: donation.image_url,
          servings: donation.servings
        });
      });
    }

    const container = document.getElementById("ngo-active-claims-list");
    container.innerHTML = "";

    if (deliveries.length === 0) {
      container.innerHTML = `<div class="empty-state"><i class="fa-solid fa-heart-crack"></i><p>You have no active claims. Visit listings tab to browse.</p></div>`;
      return;
    }

    deliveries.forEach(d => {
      const item = document.createElement("div");
      item.className = "dash-item";
      
      let mainContentHtml = "";

      if (d.type === "request") {
        mainContentHtml = `
          <div style="width:100%; display:flex; flex-direction:column; gap:12px;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap: wrap; gap: 12px;">
              <div class="dash-item-info" style="flex: 1; min-width: 200px;">
                <div class="dash-item-text">
                  <h4 style="font-size:1.05rem; margin: 0 0 4px 0;">${d.title}</h4>
                  <div class="dash-item-meta" style="display: flex; flex-direction: column; gap: 2px;">
                    <span><i class="fa-solid fa-store"></i> Hotel: ${d.donor_name || 'N/A'} (${d.donor_contact || 'N/A'})</span>
                    <a href="https://www.google.com/maps/search/?api=1&query=${d.lat},${d.lng}" target="_blank" class="btn btn-secondary btn-sm" style="padding: 2px 8px; font-size: 0.7rem; width: fit-content; display: inline-block; margin-top: 4px;"><i class="fa-solid fa-map-marker-alt"></i> Location</a>
                  </div>
                  <div style="margin-top: 4px; font-size: 0.85rem; color: var(--text-secondary);">
                    <span><i class="fa-solid fa-hourglass-half"></i> Awaiting donor approval.</span>
                  </div>
                </div>
              </div>
              <div class="dash-item-actions">
                <span class="status-badge warning">${d.status}</span>
              </div>
            </div>
          </div>
        `;
      } else {
        let stepPercentage = 0;
        let activeStepIndex = 0;
        
        if (d.status === "Assigned") {
          stepPercentage = 0;
          activeStepIndex = 0;
        } else if (d.status === "EnRouteToPickup") {
          stepPercentage = 33;
          activeStepIndex = 1;
        } else if (d.status === "InTransit") {
          stepPercentage = 66;
          activeStepIndex = 2;
        }

        let transportDetailsHtml = "";
        let actionButtonsHtml = "";

        if (d.vehicle_type === "Self-Pickup" && d.status === "Assigned") {
          transportDetailsHtml = `
            <div style="margin-top: 4px; font-size: 0.85rem; color: var(--text-secondary);">
              <span><i class="fa-solid fa-person-walking"></i> Collection Method: <strong>Self-Pickup</strong></span><br>
              <span>You are collecting this food directly from the restaurant.</span>
            </div>
          `;
          
          if (d.donation_status === "Approved") {
            transportDetailsHtml += `
              <div style="margin-top: 8px; padding: 6px 10px; background: rgba(16, 185, 129, 0.1); border-left: 3px solid #10b981; border-radius: var(--radius-sm); display: inline-block;">
                <div style="font-size: 0.85rem; margin-bottom: 4px;"><strong>Enter OTP to confirm pickup:</strong></div>
                <div class="code-input-group" style="display: flex; gap: 8px;">
                  <input type="text" class="form-input" id="ngo-otp-input-${d.listing_id}" placeholder="4-Digit OTP" maxlength="4" style="height:32px; padding:4px; max-width: 130px;">
                  <button class="btn btn-primary btn-sm" onclick="window.verifyPickupOtpAction('${d.listing_id}', '${d.id}')">Confirm Pickup</button>
                </div>
              </div>
            `;
          }

          actionButtonsHtml = `
            <div style="display: flex; gap: 8px; flex-direction: column; align-items: flex-end;">
              <span class="status-badge primary">${d.donation_status}</span>
              <div style="display: flex; gap: 8px; margin-top: 8px;">
                <button class="btn btn-secondary btn-sm" onclick="cancelClaimListing('${d.listing_id}')">Cancel</button>
                <button class="btn btn-secondary btn-sm" onclick="window.openDetailModal('${d.listing_id}')"><i class="fa-solid fa-truck-fast"></i> Transport Options</button>
              </div>
            </div>
          `;
        } else {
          let transitInfo = `Driver: ${d.driver_name || 'Finding...'} (${d.vehicle_type || 'Cab'})`;
          let plateInfo = d.vehicle_plate ? ` [Plate: ${d.vehicle_plate}]` : "";
          transportDetailsHtml = `
            <div style="margin-top: 4px; font-size: 0.85rem; color: var(--text-secondary);">
              <span><i class="fa-solid fa-truck-fast"></i> ${transitInfo}${plateInfo}</span><br>
              <span>Contact: ${d.driver_phone || 'N/A'}</span>
            </div>
          `;
          if (d.status === "InTransit") {
            actionButtonsHtml = `<button class="btn btn-primary btn-sm" onclick="markDeliveryComplete('${d.id}', '${d.listing_id}')">Mark Delivered</button>`;
          } else {
            actionButtonsHtml = `<span class="status-badge claimed">${d.status}</span>`;
          }
        }

        mainContentHtml = `
          <div style="width:100%; display:flex; flex-direction:column; gap:12px;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap: wrap; gap: 12px;">
              <div class="dash-item-info" style="flex: 1; min-width: 200px;">
                <div class="dash-item-text">
                  <h4 style="font-size:1.05rem; margin: 0 0 4px 0;">${d.title}</h4>
                  <div class="dash-item-meta" style="display: flex; flex-direction: column; gap: 2px;">
                    <span><i class="fa-solid fa-store"></i> Hotel: ${d.donor_name || 'N/A'} (${d.donor_contact || 'N/A'})</span>
                    <a href="https://www.google.com/maps/search/?api=1&query=${d.lat},${d.lng}" target="_blank" class="btn btn-secondary btn-sm" style="padding: 2px 8px; font-size: 0.7rem; width: fit-content; display: inline-block; margin-top: 4px;"><i class="fa-solid fa-map-marker-alt"></i> Location</a>
                  </div>
                  ${transportDetailsHtml}
                </div>
              </div>
              <div class="dash-item-actions">
                ${actionButtonsHtml}
              </div>
            </div>

            <!-- Stepper Wizard -->
            <div class="stepper" style="margin-top: 10px;">
              <div class="step-progress-line" style="width: ${stepPercentage}%"></div>
              <div class="step ${activeStepIndex >= 0 ? 'completed' : ''} ${activeStepIndex === 0 ? 'active' : ''}">
                <div class="step-dot">1</div>
                <span class="step-label">Assigned</span>
              </div>
              <div class="step ${activeStepIndex >= 1 ? 'completed' : ''} ${activeStepIndex === 1 ? 'active' : ''}">
                <div class="step-dot">2</div>
                <span class="step-label">Driver Matched</span>
              </div>
              <div class="step ${activeStepIndex >= 2 ? 'completed' : ''} ${activeStepIndex === 2 ? 'active' : ''}">
                <div class="step-dot">3</div>
                <span class="step-label">In Transit</span>
              </div>
              <div class="step">
                <div class="step-dot">4</div>
                <span class="step-label">Delivered</span>
              </div>
            </div>
          </div>
        `;
      }
      
      item.innerHTML = mainContentHtml;
      container.appendChild(item);
    });

  } catch (error) {
    console.error("NGO Active claims loading failed:", error);
  }
}

// --- DONOR PORTINGS FEED ---
async function loadDonorActivePostings() {
  try {
    const q = query(collection(db, "donations"), where("donor_id", "==", currentUser.uid));
    const snap = await getDocs(q);
    const myActive = snap.docs.map(doc => {
      const data = doc.data();
      const item = { id: doc.id, ...data };
      checkAndUpdateExpiry(item); // Lazy expiration
      return item;
    }).filter(d => d.status !== "Completed" && d.status !== "Expired" && d.status !== "Cancelled");
    
    const container = document.getElementById("donor-active-posts-list");
    container.innerHTML = "";

    if (myActive.length === 0) {
      container.innerHTML = `<div class="empty-state"><i class="fa-solid fa-box-open"></i><p>You have no active offerings. Use Post tab to add.</p></div>`;
      return;
    }

    myActive.forEach(item => {
      const div = document.createElement("div");
      div.className = "dash-item";
      
      let claimedInfoHtml = "";
      if (item.status === "Requested" && item.requested_by_name) {
        claimedInfoHtml = `
          <div class="claimed-info-box" style="margin-top: 10px; padding: 10px; background: rgba(255,255,255,0.05); border-radius: var(--radius-sm); font-size: 0.85rem; width: 100%;">
            <p><strong>Requested by:</strong> ${item.requested_by_name} (${item.requested_by_contact})</p>
            <div style="margin-top: 8px;">
              <button class="btn btn-primary btn-sm" onclick="window.approveRequestAction('${item.id}', '${item.requested_by}')">Approve Request</button>
            </div>
          </div>
        `;
      } else if ((item.status === "Approved" || item.status === "Claimed") && item.ngo_name) {
        let transitMethod = item.vehicle_type || "Self-Pickup";
        let delStatus = item.delivery_status || "Assigned";
        
        claimedInfoHtml = `
          <div class="claimed-info-box" style="margin-top: 10px; padding: 10px; background: rgba(255,255,255,0.05); border-radius: var(--radius-sm); font-size: 0.85rem; width: 100%;">
            <p><strong>Approved for:</strong> ${item.ngo_name} (${item.ngo_contact})</p>
            <p><strong>Transit Method:</strong> ${transitMethod} (${delStatus})</p>
        `;
        
        if (item.status === "Approved") {
          claimedInfoHtml += `
            <div style="margin-top: 8px; padding: 6px 10px; background: rgba(16, 185, 129, 0.1); border-left: 3px solid #10b981; border-radius: var(--radius-sm); display: inline-block;">
              Generated OTP: <strong style="font-size: 1.1rem; color: #10b981; letter-spacing: 2px;">${item.pickup_otp}</strong>
              <div style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 4px;">Share this OTP with the NGO/Volunteer upon arrival.</div>
            </div>
            <div style="margin-top: 10px;">
              <button class="btn btn-secondary btn-sm" onclick="window.openDetailModal('${item.id}')"><i class="fa-solid fa-truck-fast"></i> Transport Options & Details</button>
            </div>
          `;
        } else {
          claimedInfoHtml += `<p style="color: var(--color-success); font-weight: bold; margin-top: 4px;"><i class="fa-solid fa-circle-check"></i> Handover Complete (${delStatus})</p>`;
        }
        
        claimedInfoHtml += `</div>`;
      }

      div.innerHTML = `
        <div style="width: 100%; display: flex; flex-direction: column; gap: 4px;">
          <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
            <div class="dash-item-info">
              <img src="${item.image_url}" class="dash-item-img" alt="">
              <div class="dash-item-text">
                <h4>${item.title}</h4>
                <div class="dash-item-meta">
                  <span>Portions: ${item.servings}</span>
                  <span>Expires: ${new Date(item.expires_at).toLocaleTimeString()}</span>
                </div>
              </div>
            </div>
            <span class="status-badge ${item.status.toLowerCase()}">${item.status}</span>
          </div>
          ${claimedInfoHtml}
        </div>
      `;
      container.appendChild(div);
    });

  } catch (error) {
    console.error("Failed to load donor active offerings:", error);
  }
}


// ==========================================
// ADMIN DASHBOARD & MYSQL EVENT LOGS
// ==========================================
async function loadAdminPortal() {
  if (!currentUser || currentUser.role !== "admin") return;

  try {
    const q = query(collection(db, "activity_logs"), orderBy("timestamp", "desc"));
    const snap = await getDocs(q);
    const logs = snap.docs.map(doc => doc.data());
    
    const logsBox = document.getElementById("admin-logs-container");
    logsBox.innerHTML = "";

    logs.forEach(log => {
      appendAdminLog(log);
    });

    // Load active dispatchers console list (All claims)
    loadAdminDispatcherConsole();

  } catch (error) {
    console.error("Failed to load admin log audits:", error);
  }
}

function appendAdminLog(log) {
  const container = document.getElementById("admin-logs-container");
  if (!container) return;

  const row = document.createElement("div");
  row.className = `log-row ${log.eventType}`;
  row.innerHTML = `
    <div class="log-header">
      <span>[${log.eventType.toUpperCase()}]</span>
      <span>${new Date(log.timestamp).toLocaleTimeString()}</span>
    </div>
    <div class="log-msg">${log.message}</div>
  `;
  container.insertBefore(row, container.firstChild); // Insert newest first
  
  // Cap at 40 logs in UI DOM to prevent memory issues
  if (container.children.length > 40) {
    container.removeChild(container.lastChild);
  }
}

async function loadAdminDispatcherConsole() {
  try {
    // We want listings that are claimed
    const claimedListings = listings.filter(l => l.status === "Claimed");

    const container = document.getElementById("admin-dispatch-list");
    container.innerHTML = "";

    if (claimedListings.length === 0) {
      container.innerHTML = `<div class="empty-state"><i class="fa-solid fa-route"></i><p>No active claimed deliveries requiring dispatch actions.</p></div>`;
      return;
    }

    claimedListings.forEach(c => {
      const div = document.createElement("div");
      div.className = "dash-item";
      div.innerHTML = `
        <div class="dash-item-info">
          <div class="dash-item-text">
            <h4>${c.title}</h4>
            <div class="dash-item-meta">
              <span>Hotel: ${c.donor_name}</span>
              <span>Rescuer: NGO ID ${c.claimedByName || 'NGO'}</span>
              <span>Status: <strong>${c.status}</strong></span>
            </div>
          </div>
        </div>
        <div class="dash-item-actions">
          <button class="btn btn-secondary btn-sm" onclick="window.openDetailModal('${c.id}')"><i class="fa-solid fa-truck-fast"></i> Transport Options</button>
        </div>
      `;
      container.appendChild(div);
    });

  } catch (error) {
    console.error("Dispatcher list load failed:", error);
  }
}



// ==========================================
// ACTIONS & TRANSACTIONS TRIGGERS
// ==========================================

// NGO requests pickup
window.requestPickupAction = async function(listingId) {
  if (!currentUser) {
    showToast("Authentication Needed", "Please login to claim listings.", "error");
    navigateTo("auth");
    return;
  }

  try {
    // 1. Update Donation Status to Requested
    await updateDoc(doc(db, "donations", listingId), { 
      status: "Requested",
      requested_by: currentUser.uid,
      requested_by_name: currentUser.name,
      requested_by_contact: currentUser.contact,
      requested_by_address: currentUser.address || "Unknown Address"
    });

    showToast("Request Sent", "Pickup request sent to donor. Awaiting approval.", "success");
    document.getElementById("food-detail-modal").classList.remove("active");
    navigateTo("dashboard");

  } catch (e) {
    showToast("Request Failed", e.message, "error");
  }
};

// Donor approves pickup request
window.approveRequestAction = async function(listingId, ngoId) {
  try {
    const claimCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    const otp = Math.floor(1000 + Math.random() * 9000).toString();

    const donSnap = await getDoc(doc(db, "donations", listingId));
    const donation = donSnap.data();

    // Create Claim
    const claimRef = await addDoc(collection(db, "claims"), {
      donation_id: listingId,
      ngo_id: ngoId,
      claim_code: claimCode,
      status: "Active",
      created_at: new Date().toISOString()
    });

    // Create Delivery
    const deliveryRef = await addDoc(collection(db, "deliveries"), {
      donation_id: listingId,
      claim_id: claimRef.id,
      volunteer_id: null,
      status: "Assigned",
      pickup_otp: otp,
      vehicle_type: "Self-Pickup",
      driver_name: `NGO Self-Pickup (${donation.requested_by_name})`,
      driver_phone: donation.requested_by_contact,
      created_at: new Date().toISOString()
    });

    // Update Donation Status
    await updateDoc(doc(db, "donations", listingId), { 
      status: "Approved",
      ngo_id: ngoId,
      ngo_name: donation.requested_by_name,
      ngo_contact: donation.requested_by_contact,
      vehicle_type: "Self-Pickup",
      delivery_status: "Assigned",
      delivery_id: deliveryRef.id,
      pickup_otp: otp,
      claim_code: claimCode
    });

    showToast("Request Approved", `OTP generated: ${otp}`, "success");
    loadDashboardPortal();

  } catch (e) {
    showToast("Approval Failed", e.message, "error");
  }
};

// NGO confirms pickup by verifying OTP
window.verifyPickupOtpAction = async function(listingId, deliveryId) {
  const otpInputId = `ngo-otp-input-${listingId}`;
  const enteredOtp = document.getElementById(otpInputId).value;

  if (!enteredOtp || enteredOtp.length !== 4) {
    showToast("Invalid OTP", "Please enter a valid 4-digit OTP.", "warning");
    return;
  }

  try {
    const delSnap = await getDoc(doc(db, "deliveries", deliveryId));
    const deliveryData = delSnap.data();

    if (deliveryData.pickup_otp !== enteredOtp) {
      showToast("OTP Verification Failed", "Incorrect OTP. Try again.", "error");
      return;
    }

    // OTP Valid, update status
    await updateDoc(doc(db, "deliveries", deliveryId), {
      status: "InTransit"
    });

    await updateDoc(doc(db, "donations", listingId), {
      status: "Claimed",
      delivery_status: "InTransit"
    });

    showToast("OTP Verified", "Pickup confirmed! Status updated to Claimed.", "success");
    loadDashboardPortal();
  } catch (e) {
    showToast("Verification Error", e.message, "error");
  }
};

// NGO marks delivery as complete after self-pickup transit
window.markDeliveryComplete = async function(deliveryId, listingId) {
  if (!confirm("Confirm you have successfully delivered/received the items at the destination?")) return;
  try {
    const timestamp = new Date().toISOString();
    
    await updateDoc(doc(db, "deliveries", deliveryId), {
      status: "Delivered",
      completed_at: timestamp
    });

    await updateDoc(doc(db, "donations", listingId), {
      status: "Completed",
      delivery_status: "Delivered",
      completed_at: timestamp
    });

    showToast("Delivery Complete", "Thank you for rescuing food!", "success");
    loadDashboardPortal();
  } catch (e) {
    showToast("Action Failed", e.message, "error");
  }
};

window.cancelClaimListing = async function(listingId) {
  if (!confirm("Are you sure you want to cancel this claim?")) return;

  try {
    // Revert donation status
    await updateDoc(doc(db, "donations", listingId), { status: "Available" });

    // Find and cancel claim
    const claimsSnap = await getDocs(query(collection(db, "claims"), where("donation_id", "==", listingId), where("status", "==", "Active")));
    claimsSnap.forEach(async (d) => {
      await updateDoc(doc(db, "claims", d.id), { status: "Cancelled" });
    });

    showToast("Claim Cancelled", "Listing returned back to feed.", "success");
    loadDashboardPortal();

  } catch (e) {
    showToast("Action Failed", e.message, "error");
  }
};


// Restaurant (Donor) verifies collection OTP from NGO/Driver
window.verifyCollectorOtp = async function(deliveryId) {
  const otpInput = document.getElementById(`donor-otp-input-${deliveryId}`);
  if (!otpInput) return;
  const otpVal = otpInput.value.trim();

  if (!otpVal) {
    showToast("Input Required", "Please enter the 4-digit collection OTP code.", "error");
    return;
  }

  try {
    const docRef = doc(db, "deliveries", deliveryId.toString());
    const dSnap = await getDoc(docRef);
    if (!dSnap.exists()) throw new Error("Delivery not found");
    
    const deliveryData = dSnap.data();
    if (deliveryData.pickup_otp !== otpVal) throw new Error("Invalid OTP");

    await updateDoc(docRef, { status: "InTransit", handover_verified: true });
    
    // Also update the donation document so the Donor dashboard reflects the handover
    if (deliveryData.donation_id) {
      await updateDoc(doc(db, "donations", deliveryData.donation_id), { delivery_status: "InTransit" });
    }

    showToast("OTP Verified", "Handover successful and recorded!", "success");
    loadDashboardPortal();

  } catch (e) {
    showToast("Verification Failed", e.message, "error");
  }
};




// ==========================================
// LEADERBOARD LOAD
// ==========================================

async function loadLeaderboardData() {
  try {
    const snap = await getDocs(collection(db, "donations"));
    const donations = snap.docs.map(d => d.data());
    
    let donorStats = {};
    let ngoStats = {};
    
    donations.forEach(d => {
      if (d.donor_id) {
        if (!donorStats[d.donor_id]) donorStats[d.donor_id] = { name: d.donor_name || "Unknown", type: d.donor_type || "Donor", meals: 0 };
        donorStats[d.donor_id].meals += (d.servings || 0);
      }
      if (d.ngo_id) {
        if (!ngoStats[d.ngo_id]) ngoStats[d.ngo_id] = { name: d.ngo_name || "Unknown", meals: 0 };
        ngoStats[d.ngo_id].meals += (d.servings || 0);
      }
    });

    const board = {
      donors: Object.values(donorStats).sort((a,b) => b.meals - a.meals),
      ngos: Object.values(ngoStats).sort((a,b) => b.meals - a.meals)
    };

    // 1. Render Donors rankings
    const donorContainer = document.getElementById("donor-leaderboard-list");
    donorContainer.innerHTML = "";
    if (board.donors.length === 0) {
      donorContainer.innerHTML = `<div class="empty-state"><p>No donor metrics logged yet.</p></div>`;
    } else {
      board.donors.forEach((d, idx) => {
        const div = document.createElement("div");
        div.className = "leaderboard-row";
        div.innerHTML = `
          <div class="row-left">
            <span class="rank-number rank-${idx+1}">${idx+1}</span>
            <div class="avatar-icon"><i class="fa-solid ${d.type === 'Restaurant' ? 'fa-store' : 'fa-house-user'}"></i></div>
            <div class="row-details">
              <h4>${d.name}</h4>
              <span>${d.type}</span>
            </div>
          </div>
          <div class="row-right">
            <span class="row-score">${d.meals}</span>
            <span class="row-score-label">Portions</span>
          </div>
        `;
        donorContainer.appendChild(div);
      });
    }

    // 2. Render NGOs rankings
    const ngoContainer = document.getElementById("ngo-leaderboard-list");
    ngoContainer.innerHTML = "";
    if (board.ngos.length === 0) {
      ngoContainer.innerHTML = `<div class="empty-state"><p>No NGO metrics logged yet.</p></div>`;
    } else {
      board.ngos.forEach((n, idx) => {
        const div = document.createElement("div");
        div.className = "leaderboard-row";
        div.innerHTML = `
          <div class="row-left">
            <span class="rank-number rank-${idx+1}">${idx+1}</span>
            <div class="avatar-icon"><i class="fa-solid fa-hand-holding-heart"></i></div>
            <div class="row-details">
              <h4>${n.name}</h4>
              <span>NGO Rescuer</span>
            </div>
          </div>
          <div class="row-right">
            <span class="row-score">${n.meals}</span>
            <span class="row-score-label">Portions</span>
          </div>
        `;
        ngoContainer.appendChild(div);
      });
    }

  } catch (error) {
    console.error("Leaderboard load failed:", error);
  }
}

// ==========================================
// TOAST NOTIFICATIONS HELPER
// ==========================================

function showToast(title, message, type = "success") {
  const container = document.getElementById("toast-notifications-container");
  
  const toast = document.createElement("div");
  toast.className = `toast glass ${type}`;

  const icon = type === "success" ? "fa-check" : (type === "info" ? "fa-info" : "fa-exclamation");

  toast.innerHTML = `
    <div class="toast-icon"><i class="fa-solid ${icon}"></i></div>
    <div class="toast-content">
      <h4>${title}</h4>
      <p>${message}</p>
    </div>
  `;

  container.appendChild(toast);

  // Auto remove after 4.5 seconds
  setTimeout(() => {
    toast.classList.add("removing");
    setTimeout(() => {
      toast.remove();
    }, 400);
  }, 4500);
}

// ==========================================
// UI EVENT BINDINGS
// ==========================================

function setupEventListeners() {
  
  // Theme and Header actions
  document.getElementById("btn-login-trigger").addEventListener("click", () => {
    navigateTo("auth");
  });

  document.getElementById("btn-logout").addEventListener("click", () => {
    localStorage.removeItem("sb_token");
    localStorage.removeItem("sb_user");
    token = null;
    currentUser = null;
    updateAuthUI();
    showToast("Logged Out", "Session ended successfully.", "info");
    navigateTo("browse");
  });

  // Auth toggle tabs
  document.getElementById("tab-login").addEventListener("click", (e) => {
    e.target.classList.add("active");
    document.getElementById("tab-register").classList.remove("active");
    document.getElementById("card-login-form").classList.remove("hide");
    document.getElementById("card-register-form").classList.add("hide");
  });

  document.getElementById("tab-register").addEventListener("click", (e) => {
    e.target.classList.add("active");
    document.getElementById("tab-login").classList.remove("active");
    document.getElementById("card-register-form").classList.remove("hide");
    document.getElementById("card-login-form").classList.add("hide");
  });

  document.getElementById("link-to-register").addEventListener("click", (e) => {
    e.preventDefault();
    document.getElementById("tab-register").click();
  });

  document.getElementById("link-to-login").addEventListener("click", (e) => {
    e.preventDefault();
    document.getElementById("tab-login").click();
  });

  // Handle real GPS coordinate detection via HTML5 Geolocation API
  const handleGPSDetect = (latId, lngId) => {
    if (!navigator.geolocation) {
      showToast("GPS Error", "Geolocation is not supported by your browser.", "error");
      return;
    }
    
    showToast("Detecting GPS...", "Please allow location access.", "info");
    
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const lat = position.coords.latitude.toFixed(6);
        const lng = position.coords.longitude.toFixed(6);
        document.getElementById(latId).value = lat;
        document.getElementById(lngId).value = lng;
        showToast("GPS Detected", `Current location: ${lat}, ${lng}`, "success");
        
        // Optional: Update Map markers if they exist
        if (latId === 'reg-lat' && typeof regGoogleMap !== 'undefined' && regGoogleMap) {
           regGoogleMap.setCenter({ lat: parseFloat(lat), lng: parseFloat(lng) });
           if (typeof regMarker !== 'undefined' && regMarker) regMarker.setPosition({ lat: parseFloat(lat), lng: parseFloat(lng) });
        }
        if (latId === 'post-lat' && typeof postGoogleMap !== 'undefined' && postGoogleMap) {
           postGoogleMap.setCenter({ lat: parseFloat(lat), lng: parseFloat(lng) });
           if (typeof postMarker !== 'undefined' && postMarker) postMarker.setPosition({ lat: parseFloat(lat), lng: parseFloat(lng) });
        }
      },
      (error) => {
        showToast("GPS Failed", "Could not fetch location. Ensure permissions are granted.", "error");
      },
      { enableHighAccuracy: true }
    );
  };

  document.getElementById("btn-detect-gps").addEventListener("click", () => handleGPSDetect("reg-lat", "reg-lng"));
  
  const btnDetectGpsPost = document.getElementById("btn-detect-gps-post");
  if (btnDetectGpsPost) {
    btnDetectGpsPost.addEventListener("click", () => handleGPSDetect("post-lat", "post-lng"));
  }

  const btnParseLinkPost = document.getElementById("btn-parse-link-post");
  if (btnParseLinkPost) {
    btnParseLinkPost.addEventListener("click", () => {
      const e = { target: document.getElementById("post-address") };
      handleAddressInputForMapsUrl(e, "post-lat", "post-lng", postGoogleMap, postMarker);
    });
  }

  // Handle registration role sub-options
  document.querySelectorAll('[name="reg-role"]').forEach(radio => {
    radio.addEventListener("change", (e) => {
      const donorTypeGroup = document.getElementById("donor-type-group");
      if (e.target.value === "donor") {
        donorTypeGroup.classList.remove("hide");
      } else {
        donorTypeGroup.classList.add("hide");
      }
    });
  });

  // Handle forms submits
  document.getElementById("form-login").addEventListener("submit", handleLoginSubmit);
  document.getElementById("form-register").addEventListener("submit", handleRegisterSubmit);
  document.getElementById("form-post-food").addEventListener("submit", handlePostListingSubmit);

  // Add Google Auth Listeners
  document.querySelectorAll(".btn-google-auth").forEach(btn => {
    btn.addEventListener("click", handleGoogleSignIn);
  });
  
  const roleForm = document.getElementById("form-role-selection");
  if(roleForm) {
    roleForm.addEventListener("submit", handleRoleSelectionSubmit);
  }

  // Filters inputs triggers
  const filterInputs = ["filter-search", "filter-category", "filter-distance", "filter-portions", "filter-sort"];
  filterInputs.forEach(id => {
    document.getElementById(id).addEventListener("input", renderListings);
  });

  // Map toggle actions
  document.getElementById("toggle-map").addEventListener("click", () => {
    const mapPanel = document.getElementById("map-panel-container");
    mapPanel.classList.toggle("hide");
    drawMap();
  });

  document.getElementById("close-map-btn").addEventListener("click", () => {
    document.getElementById("map-panel-container").classList.add("hide");
  });

  // Modals close
  document.getElementById("modal-close-btn").addEventListener("click", () => {
    document.getElementById("food-detail-modal").classList.remove("active");
  });

  // Mobile Menu Toggle
  const mobileMenuToggle = document.getElementById("mobile-menu-toggle");
  const navMenu = document.querySelector("nav");
  if (mobileMenuToggle && navMenu) {
    mobileMenuToggle.addEventListener("click", () => {
      navMenu.classList.toggle("active");
    });
  }

  // Auto-close mobile menu on nav link click
  document.querySelectorAll("nav a").forEach(link => {
    link.addEventListener("click", () => {
      if (navMenu.classList.contains("active")) {
        navMenu.classList.remove("active");
      }
    });
  });

  // Notification Panel Toggle
  const notifBell = document.getElementById("nav-notifications");
  const notifPanel = document.getElementById("notification-panel");
  const notifClose = document.getElementById("notif-panel-close");
  
  if (notifBell && notifPanel) {
    notifBell.addEventListener("click", () => {
      notifPanel.classList.toggle("hide");
    });
  }
  if (notifClose && notifPanel) {
    notifClose.addEventListener("click", () => {
      notifPanel.classList.add("hide");
    });
  }

  document.getElementById("modal-cancel-btn").addEventListener("click", () => {
    document.getElementById("food-detail-modal").classList.remove("active");
  });
}

// Form Handlers
async function handleLoginSubmit(e) {
  e.preventDefault();
  const email = document.getElementById("login-email").value;
  const password = document.getElementById("login-password").value;

  try {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;
    
    // Auth state listener handles the rest
    showToast("Login Initiated", "Fetching user profile...", "info");
    
  } catch (error) {
    showToast("Sign In Failed", error.message, "error");
  }
}

async function handleRegisterSubmit(e) {
  e.preventDefault();
  
  const role = document.querySelector('input[name="reg-role"]:checked').value;
  const donorType = role === "donor" ? document.getElementById("reg-donor-type").value : null;
  const name = document.getElementById("reg-name").value;
  const email = document.getElementById("reg-email").value;
  const password = document.getElementById("reg-password").value;
  const address = document.getElementById("reg-address").value;
  const contact = document.getElementById("reg-contact").value;
  const latVal = document.getElementById("reg-lat").value;
  const lngVal = document.getElementById("reg-lng").value;
  const lat = latVal ? parseFloat(latVal) : 0;
  const lng = lngVal ? parseFloat(lngVal) : 0;

  try {
    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;
    
    // Save additional profile data to Firestore
    await setDoc(doc(db, "users", user.uid), {
      name,
      email,
      role,
      donor_type: donorType || null,
      address: address || "",
      contact: contact || "",
      lat: isNaN(lat) ? 0 : lat,
      lng: isNaN(lng) ? 0 : lng,
      created_at: new Date().toISOString()
    });
    
    // Auth state listener handles the rest
    showToast("Registration Complete", `Welcome to SustainaBite, ${name}!`, "success");
    navigateTo("browse");

  } catch (error) {
    showToast("Registration Failed", error.message, "error");
  }
}

async function handleGoogleSignIn(e) {
  e.preventDefault();
  try {
    const provider = new GoogleAuthProvider();
    await signInWithPopup(auth, provider);
    showToast("Google Sign-In", "Authenticating...", "info");
  } catch (error) {
    showToast("Google Auth Failed", error.message, "error");
  }
}

async function handleRoleSelectionSubmit(e) {
  e.preventDefault();
  const user = auth.currentUser;
  if (!user) {
    showToast("Error", "No authenticated user found.", "error");
    return;
  }
  
  const role = document.querySelector('input[name="g-role"]:checked').value;
  
  try {
    await setDoc(doc(db, "users", user.uid), {
      name: user.displayName || user.email.split('@')[0],
      email: user.email,
      role: role,
      created_at: new Date().toISOString()
    });
    
    document.getElementById("role-selection-modal").classList.remove("active");
    showToast("Profile Created", "Welcome to SustainaBite!", "success");
    // The snapshot listener will automatically pick this up and login the user.
  } catch (error) {
    console.error("Failed to create profile:", error);
    showToast("Profile Error", "Could not create profile.", "error");
    signOut(auth);
  }
}

async function handlePostListingSubmit(e) {
  e.preventDefault();

  const title = document.getElementById("post-title").value;
  const description = document.getElementById("post-desc").value;
  const servings = parseInt(document.getElementById("post-servings").value);
  const category = document.querySelector('input[name="post-diet"]:checked').value;
  const expiryHours = parseInt(document.getElementById("post-expiry").value);
  const address = document.getElementById("post-address").value;
  const lat = document.getElementById("post-lat").value ? parseFloat(document.getElementById("post-lat").value) : null;
  const lng = document.getElementById("post-lng").value ? parseFloat(document.getElementById("post-lng").value) : null;

  const transportOption = document.getElementById("post-transport").value;
  const transportRequired = (transportOption === "Third-party transport");

  try {
    let finalImageUrl = "";
    const fileInput = document.getElementById("post-image-upload");
    
    if (fileInput.files.length > 0) {
      showToast("Uploading...", "Uploading image to Firebase Storage...", "info");
      const file = fileInput.files[0];
      const storageRef = ref(storage, 'donations/' + Date.now() + '_' + file.name);
      const uploadTask = await uploadBytesResumable(storageRef, file);
      finalImageUrl = await getDownloadURL(storageRef);
    } else {
      const radioImg = document.querySelector('input[name="post-image"]:checked');
      if (radioImg) finalImageUrl = radioImg.value;
    }

    if (!finalImageUrl) throw new Error("Please upload an image or select a preset.");

    const expiresAt = new Date(Date.now() + (expiryHours * 60 * 60 * 1000)).toISOString();

    const newDocRef = await addDoc(collection(db, "donations"), {
      title,
      description,
      servings,
      category,
      address,
      transportOption,
      transportRequired,
      image_url: finalImageUrl,
      lat,
      lng,
      donor_id: currentUser.uid,
      donor_name: currentUser.name || "Unknown",
      donor_contact: currentUser.contact || "",
      status: "Available",
      distance: 0,
      expires_at: expiresAt,
      created_at: new Date().toISOString()
    });

    // Notify all NGOs
    try {
      const usersRef = collection(db, "users");
      const q = query(usersRef, where("role", "==", "ngo"));
      const querySnapshot = await getDocs(q);
      
      const notifPromises = [];
      querySnapshot.forEach((ngoDoc) => {
        notifPromises.push(addDoc(collection(db, "notifications"), {
          recipientId: ngoDoc.id,
          title: "New Surplus Food Available",
          message: `${currentUser.name || "A donor"} just posted ${servings} portions of ${title}.`,
          donationId: newDocRef.id,
          read: false,
          createdAt: new Date().toISOString()
        }));
      });
      await Promise.all(notifPromises);
    } catch (notifErr) {
      console.error("Failed to send notifications:", notifErr);
    }

    showToast("Surplus Posted!", "Food listing added to active feeds.", "success");
    document.getElementById("form-post-food").reset();
    navigateTo("browse");

  } catch (error) {
    showToast("Posting Failed", error.message, "error");
  }
}

// ==========================================
// GLOBALLY EXPOSED TRIGGER HELPER FUNCTION
// ==========================================

window.openDetailModal = async function(listingId) {
  let item = listings.find(l => l.id === listingId);
  
  // If not found in local feed cache (e.g. opened from dashboard for approved item)
  if (!item) {
    try {
      const docSnap = await getDoc(doc(db, "donations", listingId));
      if (docSnap.exists()) {
        item = { id: docSnap.id, ...docSnap.data() };
      }
    } catch (e) {
      console.error("Failed to fetch detail listing:", e);
    }
  }

  if (!item) {
    showToast("Error", "Could not load details.", "error");
    return;
  }

  document.getElementById("modal-title").textContent = item.title;
  document.getElementById("modal-img").src = item.image_url;
  document.getElementById("modal-description").textContent = item.description;
  document.getElementById("modal-donor").textContent = `${item.donor_name} (${item.donor_contact})`;
  if (item.address && (item.address.includes("http") || item.address.includes("www") || item.address.includes("maps"))) {
    document.getElementById("modal-address").textContent = "Map Link Provided (See below)";
  } else {
    document.getElementById("modal-address").textContent = item.address;
  }
  document.getElementById("modal-badge-cat").className = `category-badge ${item.category.toLowerCase()}`;
  document.getElementById("modal-badge-cat").textContent = item.category;
  document.getElementById("modal-badge-portions").innerHTML = `<i class="fa-solid fa-bowl-rice"></i> ${item.servings} portions`;
  document.getElementById("modal-badge-dist").innerHTML = `<i class="fa-solid fa-location-arrow"></i> ${item.distance} km`;

  // Expiry calculate
  const diffHours = (new Date(item.expires_at).getTime() - new Date().getTime()) / (1000 * 60 * 60);
  document.getElementById("modal-expiry").textContent = `${Math.floor(diffHours)}h ${Math.round((diffHours % 1) * 60)}m remaining`;

  // Set External Google Maps link
  const modalLat = parseFloat(item.lat);
  const modalLng = parseFloat(item.lng);
  document.getElementById("modal-gmaps-link").href = `https://www.google.com/maps/search/?api=1&query=${modalLat},${modalLng}`;

  // Custom modal action buttons depending on role
  const actionsBox = document.getElementById("modal-action-buttons-box");
  actionsBox.innerHTML = `<button class="btn btn-secondary" id="modal-cancel-btn-dynamic">Close</button>`;

  if (currentUser && currentUser.role === "ngo" && item.status === "Available") {
    actionsBox.innerHTML += `
      <button class="btn btn-primary" onclick="requestPickupAction('${item.id}')">
        <i class="fa-solid fa-hand-holding-heart"></i> Request Pickup
      </button>
    `;
  } else if (!token && item.status === "Available") {
    actionsBox.innerHTML += `
      <button class="btn btn-primary" onclick="navigateTo('auth')">
        Sign In to Claim
      </button>
    `;
  }

  // Handle Transportation Section
  const transportSection = document.getElementById("modal-transport-section");
  if (item.status === "Approved" || item.status === "Claimed") {
    transportSection.classList.remove("hide");
    const pickupAddress = encodeURIComponent(item.address || "");
    const dropAddress = encodeURIComponent(item.requested_by_address || item.ngo_address || "");
    
    // Uber Universal Link
    document.getElementById("btn-transport-uber").href = `https://m.uber.com/ul/?action=setPickup&pickup[formatted_address]=${pickupAddress}&dropoff[formatted_address]=${dropAddress}`;
    
    // Ola Web App URL scheme (Best effort for prefilling)
    const lat = encodeURIComponent(item.lat || "");
    const lng = encodeURIComponent(item.lng || "");
    document.getElementById("btn-transport-ola").href = `https://book.olacabs.com/?pickup_name=${pickupAddress}&drop_name=${dropAddress}&lat=${lat}&lng=${lng}`;
    
    // Rapido URL (Best effort deep link parameters)
    document.getElementById("btn-transport-rapido").href = `https://rapido.bike/?pickup=${pickupAddress}&drop=${dropAddress}`;
  } else {
    transportSection.classList.add("hide");
  }

  document.getElementById("food-detail-modal").classList.add("active");

  // Initialize detail modal map
  if (googleMapsLoaded) {
    const lat = parseFloat(item.lat);
    const lng = parseFloat(item.lng);
    setTimeout(() => {
      const modalMapDiv = document.getElementById("modal-map");
      if (modalMapDiv) {
        modalGoogleMap = new google.maps.Map(modalMapDiv, {
          center: { lat, lng },
          zoom: 15,
          styles: getDarkMapStyles(),
          mapTypeControl: false,
          streetViewControl: false
        });
        modalMarker = new google.maps.Marker({
          position: { lat, lng },
          map: modalGoogleMap,
          title: item.title,
          icon: "https://maps.google.com/mapfiles/ms/icons/red-dot.png"
        });
      }
    }, 200);
  }

  document.getElementById("modal-cancel-btn-dynamic").addEventListener("click", () => {
    document.getElementById("food-detail-modal").classList.remove("active");
  });
};
