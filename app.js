// GWEN SALES AGENT - PHASE 1 CORRECT IMPLEMENTATION
// Version: 14.0
// 
// ARCHITECTURE:
// 1. AI handles CONVERSATION (greetings, questions, qualifying, objections)
// 2. AI outputs SKUs only for product recommendations
// 3. SERVER renders product cards from verified data
// 4. Out-of-stock products filtered BEFORE AI sees them
//
// THE AI CAN WRITE CONVERSATIONAL TEXT
// THE AI CANNOT WRITE PRODUCT NAMES, PRICES, OR FEATURES

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const OpenAI = require('openai');
const fs = require('fs');
const nodemailer = require('nodemailer');

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Email configuration
const emailTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
    }
});

// Database setup
const { Pool } = require('pg');
const pool = process.env.DATABASE_URL ? new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
}) : null;

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const ENABLE_SALES_MODE = process.env.ENABLE_SALES_MODE === 'true';
const sessions = new Map();

// Shopify configuration
const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_URL || 'bb69ce-b5.myshopify.com';
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;

// ============================================
// SHOPIFY CACHING SYSTEM (5-minute TTL)
// ============================================

const SHOPIFY_CACHE = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

async function getCachedShopifyData(sku) {
    const cached = SHOPIFY_CACHE.get(sku);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
        return cached.data;
    }
    
    if (!SHOPIFY_ACCESS_TOKEN) {
        return null;
    }
    
    try {
        const response = await fetch(
            `https://${SHOPIFY_DOMAIN}/admin/api/2024-01/products.json?handle=${sku.toLowerCase()}`,
            {
                headers: {
                    'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        if (!response.ok) return null;
        
        const data = await response.json();
        const product = data.products?.[0];
        
        if (!product) return null;
        
        const result = {
            price: parseFloat(product.variants[0]?.price) || 0,
            stock: product.variants[0]?.inventory_quantity || 0,
            url: `https://www.mint-outdoor.com/products/${product.handle}`,
            available: product.variants[0]?.inventory_quantity > 0,
            title: product.title
        };
        
        SHOPIFY_CACHE.set(sku, { data: result, timestamp: Date.now() });
        return result;
        
    } catch (error) {
        console.error(`Shopify error for ${sku}:`, error.message);
        return null;
    }
}

// ============================================
// DATA LOADING
// ============================================

function loadDataFile(filename, defaultValue = []) {
    const dataPath = path.join(__dirname, 'data', filename);
    try {
        const rawData = fs.readFileSync(dataPath, 'utf8');
        const parsedData = JSON.parse(rawData);
        console.log(`✅ Loaded ${filename}`);
        return parsedData;
    } catch (error) {
        console.error(`❌ Failed to load ${filename}: ${error.message}`);
        return defaultValue;
    }
}

const productKnowledgeCenter = loadDataFile('product_knowledge_center.json', []);
const rawInventoryData = loadDataFile('Inventory_Data.json', { inventory: [] });
const inventoryData = Array.isArray(rawInventoryData) ? rawInventoryData : (rawInventoryData.inventory || []);
const bundleSuggestions = loadDataFile('bundle_suggestions.json', []);
const bundleItems = loadDataFile('bundle_items.json', []);

console.log(`📦 Inventory data type: ${typeof rawInventoryData}`);
console.log(`📦 Inventory is array after processing: ${Array.isArray(inventoryData)}`);
console.log(`📦 Inventory length: ${inventoryData.length}`);

// Check FARO specifically
const faroInventory = inventoryData.find(i => i.sku === 'FARO-LOUNGE-SET');
if (faroInventory) {
    console.log(`✅ FARO-LOUNGE-SET in inventory: available=${faroInventory.available}`);
} else {
    console.log(`❌ FARO-LOUNGE-SET NOT in inventory array`);
    console.log(`   First 3 inventory SKUs: ${inventoryData.slice(0, 3).map(i => i.sku).join(', ')}`);
}

// Build product index
const productIndex = { bySku: {} };
productKnowledgeCenter.forEach(product => {
    const sku = product.product_identity?.sku;
    if (sku) {
        productIndex.bySku[sku] = product;
    }
});

console.log(`📦 Indexed ${Object.keys(productIndex.bySku).length} products`);
console.log(`📦 Inventory records: ${inventoryData.length}`);

// Verify specific product exists
const testProduct = productIndex.bySku['FARO-LOUNGE-SET'];
if (testProduct) {
    console.log(`✅ FARO-LOUNGE-SET found in index:`);
    console.log(`   - Name: ${testProduct.product_identity?.product_name}`);
    console.log(`   - Material: ${testProduct.description_and_category?.material_type}`);
    console.log(`   - Taxonomy: ${testProduct.description_and_category?.taxonomy_type}`);
    console.log(`   - Seats: ${testProduct.specifications?.seats} (type: ${typeof testProduct.specifications?.seats})`);
} else {
    console.log(`❌ FARO-LOUNGE-SET NOT FOUND in index!`);
    console.log(`   Sample SKUs: ${Object.keys(productIndex.bySku).slice(0, 5).join(', ')}`);
}

// Count rattan products
const rattanCount = Object.values(productIndex.bySku).filter(p => 
    p.description_and_category?.material_type?.toLowerCase() === 'rattan'
).length;
console.log(`📦 Rattan products: ${rattanCount}`);

// ============================================
// STOCK CHECKING - Filter BEFORE AI sees products
// ============================================

function getProductStock(sku) {
    let stockFromInventory = 0;
    let stockFromPKC = 0;
    
    // Check inventory data
    const invRecord = inventoryData.find(i => i.sku === sku);
    if (invRecord) {
        stockFromInventory = parseInt(invRecord.available) || 0;
    }
    
    // Check product knowledge center
    const product = productIndex.bySku[sku];
    if (product?.logistics_and_inventory?.inventory?.available) {
        stockFromPKC = parseInt(product.logistics_and_inventory.inventory.available) || 0;
    }
    
    // Use the higher value (in case one source is outdated)
    const finalStock = Math.max(stockFromInventory, stockFromPKC);
    
    // Debug logging for troubleshooting
    if (sku === 'FARO-LOUNGE-SET' || finalStock === 0) {
        console.log(`📊 getProductStock(${sku}): inventory=${stockFromInventory}, PKC=${stockFromPKC}, using=${finalStock}`);
    }
    
    // If no data at all, default to in stock (100)
    if (stockFromInventory === 0 && stockFromPKC === 0 && !invRecord && !product?.logistics_and_inventory?.inventory) {
        return 100;
    }
    
    return finalStock;
}

function isInStock(sku) {
    return getProductStock(sku) > 0;
}

// ============================================
// PRODUCT SEARCH - Returns ONLY in-stock products
// ============================================

function searchProducts(criteria) {
    const { furnitureType, material, seatCount, productName, maxResults = 5 } = criteria;
    
    let filtered = Object.values(productIndex.bySku).filter(p => 
        p.product_identity?.sku && 
        p.description_and_category?.primary_category
    );
    
    console.log(`🔍 Search criteria: type=${furnitureType}, material=${material}, seats=${seatCount}`);
    console.log(`🔍 Starting with ${filtered.length} products`);
    
    // Filter by furniture type
    if (furnitureType) {
        const type = furnitureType.toLowerCase();
        const beforeCount = filtered.length;
        filtered = filtered.filter(p => {
            const taxonomy = p.description_and_category?.taxonomy_type?.toLowerCase() || '';
            const category = p.description_and_category?.primary_category?.toLowerCase() || '';
            const name = p.product_identity?.product_name?.toLowerCase() || '';
            
            if (type === 'dining') return taxonomy.includes('dining') || category.includes('dining') || name.includes('dining');
            if (type === 'lounge') return taxonomy.includes('lounge') || category.includes('lounge') || name.includes('lounge') || name.includes('sofa');
            if (type === 'corner') return taxonomy.includes('corner') || name.includes('corner');
            if (type === 'lounger') return taxonomy.includes('lounger') || name.includes('lounger') || name.includes('sun');
            return true; // If unknown type, don't filter
        });
        console.log(`🔍 After furniture type filter (${type}): ${filtered.length} products (was ${beforeCount})`);
    }
    
    // Filter by material
    if (material) {
        const mat = material.toLowerCase();
        const beforeCount = filtered.length;
        filtered = filtered.filter(p => {
            const materialType = p.description_and_category?.material_type?.toLowerCase() || '';
            const name = p.product_identity?.product_name?.toLowerCase() || '';
            return materialType.includes(mat) || name.includes(mat);
        });
        console.log(`🔍 After material filter (${mat}): ${filtered.length} products (was ${beforeCount})`);
    }
    
    // Filter by seat count - MINIMUM seats, not approximate
    if (seatCount) {
        const target = parseInt(seatCount);
        const beforeCount = filtered.length;
        const beforeFilter = filtered.map(p => ({
            sku: p.product_identity?.sku,
            seats: p.specifications?.seats
        }));
        console.log(`🔍 Products before seat filter:`, beforeFilter.slice(0, 10));
        
        filtered = filtered.filter(p => {
            const seats = parseInt(p.specifications?.seats);
            // Must have AT LEAST the requested number of seats
            return seats && seats >= target;
        });
        console.log(`🔍 After seat filter (>=${target}): ${filtered.length} products (was ${beforeCount})`);
        
        // If no exact matches, try slightly smaller but warn
        if (filtered.length === 0 && beforeCount > 0) {
            console.log(`   ⚠️ No products with ${target}+ seats, showing best available`);
            // Go back to before seat filter and sort by seats descending
            filtered = Object.values(productIndex.bySku).filter(p => {
                if (material) {
                    const mt = p.description_and_category?.material_type?.toLowerCase() || '';
                    if (!mt.includes(material.toLowerCase())) return false;
                }
                if (furnitureType) {
                    const taxonomy = p.description_and_category?.taxonomy_type?.toLowerCase() || '';
                    const name = p.product_identity?.product_name?.toLowerCase() || '';
                    if (furnitureType === 'lounge' && !taxonomy.includes('lounge') && !name.includes('lounge')) return false;
                }
                const seats = parseInt(p.specifications?.seats);
                return seats && seats > 0;
            });
            filtered.sort((a, b) => (parseInt(b.specifications?.seats) || 0) - (parseInt(a.specifications?.seats) || 0));
        }
    }
    
    // Filter by name
    if (productName) {
        const search = productName.toLowerCase();
        filtered = filtered.filter(p => {
            const name = p.product_identity?.product_name?.toLowerCase() || '';
            const sku = p.product_identity?.sku?.toLowerCase() || '';
            return name.includes(search) || sku.includes(search);
        });
    }
    
    // CRITICAL: Filter out-of-stock products BEFORE returning to AI
    const beforeStockCount = filtered.length;
    const inStockProducts = filtered.filter(p => {
        const sku = p.product_identity.sku;
        const stock = getProductStock(sku);
        if (stock <= 0) {
            console.log(`   ❌ Filtering out ${sku} - out of stock`);
            return false;
        }
        return true;
    });
    
    console.log(`🔍 After stock filter: ${inStockProducts.length} products (was ${beforeStockCount})`);
    
    const results = inStockProducts.slice(0, maxResults);
    
    console.log(`🔍 Final results: ${results.map(p => p.product_identity.sku + '(' + p.specifications?.seats + ' seats)').join(', ')}`);
    
    return results.map(p => ({
        sku: p.product_identity.sku,
        name: p.product_identity.product_name,
        category: p.description_and_category?.primary_category,
        seats: p.specifications?.seats,
        material: p.description_and_category?.material_type
    }));
}

// ============================================
// SERVER-SIDE PRODUCT CARD RENDERING
// ============================================

async function renderProductCard(sku, options = {}) {
    const { showBundleHint = false, personalisation = '' } = options;
    
    const productData = productIndex.bySku[sku];
    if (!productData) {
        console.log(`⚠️ No product data for SKU: ${sku}`);
        return null;
    }
    
    // Get live Shopify data
    const shopifyData = await getCachedShopifyData(sku);
    
    // Determine price - prefer Shopify, fallback to local
    const price = shopifyData?.price || 
                  parseFloat(productData.product_identity?.price_gbp) || 0;
    
    // Determine stock
    const stock = shopifyData?.stock ?? getProductStock(sku);
    
    // Double-check stock
    if (stock <= 0) {
        console.log(`⚠️ ${sku} out of stock at render time`);
        return null;
    }
    
    const name = productData.product_identity?.product_name || 'Product';
    const imageUrl = productData.product_identity?.image_url || '';
    const productUrl = shopifyData?.url || `https://www.mint-outdoor.com/search?q=${sku}`;
    
    // Extract REAL features from materials
    const features = [];
    const warranties = [];
    
    if (productData.materials_and_care) {
        productData.materials_and_care.forEach(mat => {
            if (mat.warranty) {
                warranties.push(`${mat.name}: ${mat.warranty}`);
            }
            if (mat.pros) {
                const firstPro = mat.pros.split(',')[0].trim();
                if (firstPro && !features.includes(firstPro)) {
                    features.push(firstPro);
                }
            }
        });
    }
    
    // Add specs
    if (productData.specifications?.seats) {
        features.unshift(`Seats ${productData.specifications.seats} people`);
    }
    
    // Stock message
    let stockMessage = '';
    if (stock <= 5) {
        stockMessage = `🚨 Only ${stock} left!`;
    } else if (stock <= 20) {
        stockMessage = `⚠️ Low stock - ${stock} remaining`;
    } else {
        stockMessage = `✅ In stock`;
    }
    
    // Build card
    let card = `\n**${name}**\n`;
    
    if (imageUrl) {
        card += `<a href="${productUrl}" target="_blank"><img src="${imageUrl}" alt="${name}" style="max-width:100%; border-radius:8px; margin:8px 0; cursor:pointer;"></a>\n\n`;
    }
    
    if (personalisation) {
        card += `✨ *${personalisation}*\n\n`;
    }
    
    if (features.length > 0) {
        card += `**Why customers love this:**\n`;
        features.slice(0, 3).forEach(f => {
            card += `• ${f}\n`;
        });
    }
    
    if (warranties.length > 0) {
        card += `\n**Warranty:** ${warranties[0]}\n`;
    }
    
    card += `\n**Price:** £${price.toFixed(2)}\n`;
    card += `**Stock:** ${stockMessage}\n\n`;
    card += `<a href="${productUrl}" target="_blank" style="display:inline-block; padding:10px 20px; background:#2E6041; color:white; text-decoration:none; border-radius:5px;">View Product →</a>\n`;
    
    if (showBundleHint && productData.related_products?.matching_cover_sku) {
        card += `\n🎁 *Matching cover available - ask about our 20% bundle discount!*\n`;
    }
    
    return card;
}

async function renderMultipleProducts(skus, personalisation = '') {
    const cards = [];
    
    for (let i = 0; i < skus.length; i++) {
        const card = await renderProductCard(skus[i], {
            showBundleHint: (i === 0),
            personalisation: (i === 0) ? personalisation : ''
        });
        
        if (card) {
            cards.push(card);
        }
    }
    
    return cards;
}

// ============================================
// AI SYSTEM PROMPT
// ============================================

function buildSystemPrompt(sessionState) {
    // Build a clear summary of what we know
    let contextSummary = "Nothing established yet - ask qualifying questions.";
    const est = sessionState.established || {};
    const known = [];
    if (est.furnitureType) known.push(`Type: ${est.furnitureType}`);
    if (est.seatCount) known.push(`Seats: ${est.seatCount}+`);
    if (est.material) known.push(`Material: ${est.material}`);
    if (known.length > 0) {
        contextSummary = known.join(', ');
    }
    
    return `You are Gwen, a warm and knowledgeable sales assistant for MINT Outdoor furniture.

CRITICAL: PAY ATTENTION TO CONVERSATION HISTORY
- The conversation history is provided below
- DO NOT ask questions the customer has already answered
- If customer mentioned "aluminium" - remember it
- If customer mentioned "4 people" - remember it
- If customer mentioned "lounge" - remember it

WHAT WE KNOW ABOUT THIS CUSTOMER:
${contextSummary}

YOUR PERSONALITY:
- Friendly, helpful, not pushy
- Expert in outdoor furniture
- Focus on understanding customer needs before showing products

CONVERSATION FLOW:
1. Greet warmly
2. Ask qualifying questions ONLY if not already answered
3. Show products when you have enough information (type + size OR material + size)
4. Handle questions about warranty, materials, delivery
5. Offer bundles at the right moment

CRITICAL RULES FOR PRODUCTS:
- You CANNOT write product names, prices, or features
- When recommending products, output SKUs only in selected_skus array
- The server will render the actual product cards
- Only recommend SKUs from the AVAILABLE list

OUTPUT FORMAT - Always respond with valid JSON:

For conversation (greetings, questions, answers):
{
    "intent": "greeting" or "clarification" or "question_answer" or "objection_handling",
    "response_text": "Your conversational response here"
}

For showing products (SERVER RENDERS THESE):
{
    "intent": "product_recommendation",
    "intro_copy": "Based on what you've told me, here are some perfect options:",
    "selected_skus": ["SKU-1", "SKU-2"],
    "personalisation": "Perfect for relaxing with family",
    "closing_copy": "Which style catches your eye?"
}

AVAILABLE PRODUCT SKUs (only use these for selected_skus):
${sessionState.availableSkus?.length > 0 ? sessionState.availableSkus.join(', ') : 'No search performed yet'}

INTENT TYPES:
- greeting: First message or returning greeting
- clarification: Need more info (but ONLY if not already provided!)
- product_recommendation: Ready to show products (use selected_skus)
- question_answer: Answering specific questions
- bundle_offer: Offering bundle deal
- objection_handling: Addressing concerns

REMEMBER:
- READ THE CONVERSATION HISTORY CAREFULLY
- NEVER ask for information already provided
- Be conversational and warm
- When showing products, use SKUs only - never write product names or prices`;
}

// ============================================
// AI TOOLS
// ============================================

const aiTools = [
    {
        type: "function",
        function: {
            name: "search_products",
            description: "Search for products. Only call this when you have enough information from the customer (furniture type, approximate size/seats, optional material preference).",
            parameters: {
                type: "object",
                properties: {
                    furnitureType: {
                        type: "string",
                        enum: ["dining", "lounge", "corner", "lounger"],
                        description: "Type of furniture"
                    },
                    material: {
                        type: "string",
                        description: "Material preference (teak, aluminium, rattan)"
                    },
                    seatCount: {
                        type: "integer",
                        description: "Number of seats needed"
                    },
                    productName: {
                        type: "string",
                        description: "Specific product name to search"
                    }
                }
            }
        }
    },
    {
        type: "function", 
        function: {
            name: "get_material_info",
            description: "Get detailed information about a material type for answering customer questions",
            parameters: {
                type: "object",
                properties: {
                    material: {
                        type: "string",
                        enum: ["teak", "aluminium", "rattan", "steel"],
                        description: "Material to get info about"
                    }
                },
                required: ["material"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "request_human_handoff",
            description: "Request handoff to human agent when customer needs help beyond your capabilities",
            parameters: {
                type: "object",
                properties: {
                    reason: {
                        type: "string",
                        description: "Reason for handoff"
                    },
                    customerEmail: {
                        type: "string",
                        description: "Customer's email if provided"
                    }
                },
                required: ["reason"]
            }
        }
    }
];

// Material information
const materialInfo = {
    teak: {
        warranty: "5 years structural",
        maintenance: "Oil annually to keep golden colour, or let weather naturally to silver-grey",
        durability: "25+ years lifespan",
        pros: "Beautiful natural wood, extremely durable, naturally weather-resistant",
        cons: "Requires some maintenance, higher price point"
    },
    aluminium: {
        warranty: "10 years against corrosion",
        maintenance: "Virtually none - just wipe with soapy water",
        durability: "20+ years lifespan",
        pros: "Zero maintenance, rust-proof, lightweight, modern look",
        cons: "Can get hot in direct sun"
    },
    rattan: {
        warranty: "2 years structural and colour retention",
        maintenance: "Cover during harsh winter, otherwise maintenance-free",
        durability: "10-15 years with care",
        pros: "UV-tested to 2000 hours, comfortable, affordable",
        cons: "Synthetic material, should be covered in extreme weather"
    },
    steel: {
        warranty: "3 years against rust",
        maintenance: "Check for scratches annually, touch up if needed",
        durability: "15+ years",
        pros: "Very strong, often powder-coated for protection",
        cons: "Can rust if coating damaged"
    }
};

// ============================================
// VALIDATE AI OUTPUT
// ============================================

function validateAIOutput(aiOutput, whitelist, sessionId) {
    if (!aiOutput.intent) {
        console.log(`⚠️ [${sessionId}] Missing intent`);
        return null;
    }
    
    // For product recommendations, validate SKUs
    if (aiOutput.intent === 'product_recommendation' && aiOutput.selected_skus) {
        const validSkus = [];
        const invalidSkus = [];
        
        for (const sku of aiOutput.selected_skus) {
            if (whitelist.includes(sku)) {
                validSkus.push(sku);
            } else {
                invalidSkus.push(sku);
                console.log(`🛡️ [${sessionId}] BLOCKED: "${sku}" not in whitelist`);
            }
        }
        
        aiOutput.selected_skus = validSkus;
        
        if (invalidSkus.length > 0) {
            console.log(`🛡️ Whitelist was: [${whitelist.join(', ')}]`);
        }
    }
    
    return aiOutput;
}

// ============================================
// ASSEMBLE FINAL RESPONSE
// ============================================

async function assembleResponse(aiOutput, sessionId) {
    const intent = aiOutput.intent;
    
    // For non-product intents, use AI's response text directly
    if (intent !== 'product_recommendation') {
        return aiOutput.response_text || "I'm here to help! What would you like to know about our outdoor furniture?";
    }
    
    // For product recommendations, render cards server-side
    const parts = [];
    
    if (aiOutput.intro_copy) {
        parts.push(aiOutput.intro_copy);
    }
    
    if (aiOutput.selected_skus && aiOutput.selected_skus.length > 0) {
        const cards = await renderMultipleProducts(
            aiOutput.selected_skus,
            aiOutput.personalisation || ''
        );
        
        if (cards.length > 0) {
            parts.push('');
            parts.push(cards.join('\n---\n'));
        } else {
            parts.push("\nI'm sorry, but the products I wanted to show you aren't currently available. Let me find some alternatives - what's most important to you: material, size, or style?");
            return parts.join('\n');
        }
    }
    
    if (aiOutput.closing_copy) {
        parts.push('');
        parts.push(aiOutput.closing_copy);
    }
    
    return parts.join('\n');
}

// ============================================
// MAIN CHAT ENDPOINT
// ============================================

app.post('/chat', async (req, res) => {
    try {
        const { message, sessionId } = req.body;
        
        if (!message || !sessionId) {
            return res.status(400).json({ 
                response: 'Please provide a message and session ID.'
            });
        }
        
        console.log(`\n${'='.repeat(60)}`);
        console.log(`📩 [${sessionId}] "${message}"`);
        
        // Get or create session
        if (!sessions.has(sessionId)) {
            sessions.set(sessionId, {
                messageCount: 0,
                conversationHistory: [],
                currentWhitelist: [],
                context: {
                    furnitureType: null,
                    seatCount: null,
                    material: null
                },
                commercial: {
                    bundlesOffered: 0,
                    bundleDeclined: false,
                    productsShown: []
                }
            });
        }
        
        const session = sessions.get(sessionId);
        session.messageCount++;
        
        // Extract context from user message
        const msgLower = message.toLowerCase();
        if (msgLower.includes('aluminium') || msgLower.includes('aluminum')) {
            session.context.material = 'aluminium';
            console.log(`📝 Context: material = aluminium`);
        }
        if (msgLower.includes('rattan')) {
            session.context.material = 'rattan';
            console.log(`📝 Context: material = rattan`);
        }
        if (msgLower.includes('teak')) {
            session.context.material = 'teak';
            console.log(`📝 Context: material = teak`);
        }
        if (msgLower.includes('dining')) {
            session.context.furnitureType = 'dining';
            console.log(`📝 Context: type = dining`);
        }
        if (msgLower.includes('lounge') || msgLower.includes('lounging')) {
            session.context.furnitureType = 'lounge';
            console.log(`📝 Context: type = lounge`);
        }
        if (msgLower.includes('corner')) {
            session.context.furnitureType = 'corner';
            console.log(`📝 Context: type = corner`);
        }
        // Extract seat count
        const seatMatch = msgLower.match(/(\d+)\s*(?:people|person|seat|seater)/);
        if (seatMatch) {
            session.context.seatCount = parseInt(seatMatch[1]);
            console.log(`📝 Context: seats = ${session.context.seatCount}`);
        }
        
        // Build session state for AI
        const sessionState = {
            messageCount: session.messageCount,
            established: session.context,
            commercial: session.commercial,
            availableSkus: session.currentWhitelist
        };
        
        const systemPrompt = buildSystemPrompt(sessionState);
        
        // CRITICAL: Include conversation history so AI has context
        let messages = [
            { role: "system", content: systemPrompt }
        ];
        
        // Add conversation history (previous exchanges)
        for (const msg of session.conversationHistory) {
            messages.push(msg);
        }
        
        // Add current user message
        messages.push({ role: "user", content: message });
        
        console.log(`💬 Sending ${messages.length} messages to AI (${session.conversationHistory.length} history)`);
        console.log(`📋 Context: ${JSON.stringify(session.context)}`);
        
        // Call AI
        let response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: messages,
            tools: aiTools,
            tool_choice: "auto",
            temperature: 0.4
        });
        
        let aiMessage = response.choices[0].message;
        
        // Handle tool calls
        if (aiMessage.tool_calls) {
            const toolResults = [];
            
            for (const toolCall of aiMessage.tool_calls) {
                const args = JSON.parse(toolCall.function.arguments);
                
                if (toolCall.function.name === "search_products") {
                    console.log(`🔍 Search:`, args);
                    
                    if (args.furnitureType) session.context.furnitureType = args.furnitureType;
                    if (args.seatCount) session.context.seatCount = args.seatCount;
                    if (args.material) session.context.material = args.material;
                    
                    const products = searchProducts(args);
                    
                    session.currentWhitelist = products.map(p => p.sku);
                    console.log(`🛡️ Whitelist: [${session.currentWhitelist.join(', ')}]`);
                    
                    // Check if products actually meet the seat requirement
                    let seatWarning = null;
                    if (args.seatCount && products.length > 0) {
                        const requestedSeats = parseInt(args.seatCount);
                        const maxSeatsFound = Math.max(...products.map(p => parseInt(p.seats) || 0));
                        if (maxSeatsFound < requestedSeats) {
                            seatWarning = `Customer requested ${requestedSeats}+ seats but largest available is ${maxSeatsFound} seats. Be honest about this limitation.`;
                        }
                    }
                    
                    toolResults.push({
                        tool_call_id: toolCall.id,
                        output: JSON.stringify({
                            success: products.length > 0,
                            available_skus: session.currentWhitelist,
                            count: products.length,
                            products: products,
                            searched_for: args,
                            warning: seatWarning,
                            note: products.length > 0 
                                ? "Use ONLY these SKUs. Server renders details. " + (seatWarning || "")
                                : "No in-stock products found matching criteria. Suggest alternatives or ask about different requirements."
                        })
                    });
                }
                
                if (toolCall.function.name === "get_material_info") {
                    const info = materialInfo[args.material] || {
                        warranty: "Please contact us for details",
                        maintenance: "Varies by product"
                    };
                    
                    toolResults.push({
                        tool_call_id: toolCall.id,
                        output: JSON.stringify(info)
                    });
                }
                
                if (toolCall.function.name === "request_human_handoff") {
                    console.log(`📧 Handoff requested: ${args.reason}`);
                    
                    toolResults.push({
                        tool_call_id: toolCall.id,
                        output: JSON.stringify({
                            success: true,
                            message: "Handoff logged. Tell customer a team member will be in touch."
                        })
                    });
                }
            }
            
            messages.push(aiMessage);
            
            for (const result of toolResults) {
                messages.push({
                    role: "tool",
                    content: result.output,
                    tool_call_id: result.tool_call_id
                });
            }
            
            sessionState.availableSkus = session.currentWhitelist;
            messages[0].content = buildSystemPrompt(sessionState);
            
            response = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: messages,
                response_format: { type: "json_object" },
                temperature: 0.4
            });
            
            aiMessage = response.choices[0].message;
        }
        
        // Parse AI output
        let aiOutput;
        try {
            aiOutput = JSON.parse(aiMessage.content);
            console.log(`✅ AI intent: ${aiOutput.intent}`);
        } catch (e) {
            console.error(`❌ Invalid JSON:`, aiMessage.content?.substring(0, 200));
            aiOutput = {
                intent: 'greeting',
                response_text: "Hello! Welcome to MINT Outdoor. I'd love to help you find the perfect outdoor furniture. Are you looking for a dining set, lounge set, or something else?"
            };
        }
        
        // Validate
        aiOutput = validateAIOutput(aiOutput, session.currentWhitelist, sessionId);
        
        if (!aiOutput) {
            aiOutput = {
                intent: 'clarification',
                response_text: "I'd love to help you find the perfect outdoor furniture. Are you looking for dining, lounging, or both?"
            };
        }
        
        // Assemble response
        const finalResponse = await assembleResponse(aiOutput, sessionId);
        
        // NOW add to conversation history (after we have the response)
        session.conversationHistory.push({ role: 'user', content: message });
        session.conversationHistory.push({ role: 'assistant', content: finalResponse });
        
        // Keep history manageable (last 8 messages = 4 exchanges)
        if (session.conversationHistory.length > 8) {
            session.conversationHistory = session.conversationHistory.slice(-8);
        }
        
        if (aiOutput.intent === 'product_recommendation' && aiOutput.selected_skus) {
            session.commercial.productsShown.push(...aiOutput.selected_skus);
        }
        
        console.log(`📤 Response (${finalResponse.length} chars)`);
        console.log(`${'='.repeat(60)}\n`);
        
        res.json({
            response: finalResponse,
            sessionId: sessionId
        });
        
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({
            response: "I apologize, but I'm having a technical issue. Please try again.",
            error: error.message
        });
    }
});

// ============================================
// DEBUG ENDPOINTS
// ============================================

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        version: '14.0 - Full Conversation + Server Rendering',
        products: Object.keys(productIndex.bySku).length,
        inventory_records: inventoryData.length
    });
});

app.get('/debug-products', (req, res) => {
    const products = Object.values(productIndex.bySku).slice(0, 30).map(p => ({
        sku: p.product_identity?.sku,
        name: p.product_identity?.product_name,
        stock: getProductStock(p.product_identity?.sku)
    }));
    
    res.json({
        total: Object.keys(productIndex.bySku).length,
        in_stock: products.filter(p => p.stock > 0).length,
        sample: products
    });
});

// Debug endpoint to check inventory data specifically
app.get('/debug-inventory', (req, res) => {
    // Check if FARO-LOUNGE-SET is in inventory data
    const faroInInventory = inventoryData.find(i => i.sku === 'FARO-LOUNGE-SET');
    
    res.json({
        inventory_is_array: Array.isArray(inventoryData),
        inventory_length: inventoryData.length,
        sample_records: inventoryData.slice(0, 5),
        faro_in_inventory: faroInInventory || 'NOT FOUND',
        faro_stock_from_function: getProductStock('FARO-LOUNGE-SET')
    });
});

app.get('/debug-session/:sessionId', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    if (!session) return res.json({ error: 'Session not found' });
    res.json(session);
});

// Debug endpoint to test search directly
app.get('/debug-search', (req, res) => {
    const { type, material, seats } = req.query;
    console.log(`\n🧪 DEBUG SEARCH: type=${type}, material=${material}, seats=${seats}`);
    
    const results = searchProducts({
        furnitureType: type || undefined,
        material: material || undefined,
        seatCount: seats ? parseInt(seats) : undefined
    });
    
    res.json({
        query: { type, material, seats },
        count: results.length,
        results: results
    });
});

// Debug endpoint to check specific product
app.get('/debug-product/:sku', (req, res) => {
    const sku = req.params.sku;
    const product = productIndex.bySku[sku];
    
    if (!product) {
        const allSkus = Object.keys(productIndex.bySku);
        const matches = allSkus.filter(s => s.toLowerCase().includes(sku.toLowerCase()));
        return res.json({
            error: `Product ${sku} not found`,
            did_you_mean: matches.slice(0, 5),
            total_products: allSkus.length
        });
    }
    
    // Check inventory data directly
    const invRecord = inventoryData.find(i => i.sku === sku);
    
    // Check PKC data
    const pkcStock = product?.logistics_and_inventory?.inventory?.available;
    
    const stock = getProductStock(sku);
    
    res.json({
        sku: sku,
        found: true,
        name: product.product_identity?.product_name,
        material_type: product.description_and_category?.material_type,
        taxonomy_type: product.description_and_category?.taxonomy_type,
        seats: product.specifications?.seats,
        seats_type: typeof product.specifications?.seats,
        stock_sources: {
            inventory_data: invRecord ? invRecord.available : 'NOT FOUND',
            pkc_data: pkcStock || 'NOT FOUND',
            function_result: stock
        },
        inventory_record: invRecord || 'NOT FOUND',
        would_pass_filters: {
            has_sku: !!product.product_identity?.sku,
            has_category: !!product.description_and_category?.primary_category,
            material_is_rattan: product.description_and_category?.material_type?.toLowerCase() === 'rattan',
            seats_gte_8: (parseInt(product.specifications?.seats) || 0) >= 8,
            is_lounge: product.description_and_category?.taxonomy_type?.toLowerCase().includes('lounge'),
            is_in_stock: stock > 0
        }
    });
});

// Debug endpoint to find all rattan products
app.get('/debug-rattan', (req, res) => {
    const allProducts = Object.values(productIndex.bySku);
    
    const rattanProducts = allProducts.filter(p => {
        const materialType = p.description_and_category?.material_type?.toLowerCase() || '';
        return materialType.includes('rattan');
    });
    
    const result = rattanProducts.map(p => ({
        sku: p.product_identity?.sku,
        name: p.product_identity?.product_name,
        material: p.description_and_category?.material_type,
        taxonomy: p.description_and_category?.taxonomy_type,
        seats: p.specifications?.seats,
        stock: getProductStock(p.product_identity?.sku)
    }));
    
    res.json({
        total_products: allProducts.length,
        rattan_count: rattanProducts.length,
        rattan_products: result
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'chat.html'));
});

app.get('/widget', (req, res) => {
    res.sendFile(path.join(__dirname, 'widget.html'));
});

// =====================================================
// GWEN AUTOMATED TEST RUNNER v1.0
// =====================================================
// 
// HOW TO ADD TO YOUR APP.JS:
// 
// 1. Open your App.js file
// 2. Find this line near the end (around line 3117):
//    // ============================================
//    // SERVER STARTUP
//    // ============================================
// 
// 3. PASTE all the code below DIRECTLY ABOVE that line
// 4. Save the file
// 5. Push to Heroku: git add . && git commit -m "Add test runner" && git push heroku main
// 6. Access tests at: https://gwen-test-staging.herokuapp.com/run-tests
// 
// =====================================================

// ============================================
// TEST SCENARIOS
// ============================================

const TEST_SCENARIOS = {
  "fuzzy_product_matching": [
    {
      id: "FUZZY-001",
      name: "Vague seating request",
      input: "I need something to sit on outside",
      expect_any: ["sofa", "lounge", "seating", "corner", "seat", "Sofa", "Lounge", "Corner"]
    },
    {
      id: "FUZZY-002",
      name: "Relaxation focused",
      input: "somewhere to chill and have drinks",
      expect_any: ["lounge", "sofa", "corner", "Lounge", "Sofa", "Corner"]
    },
    {
      id: "FUZZY-003",
      name: "Sunbathing request",
      input: "want to sunbathe in my garden",
      expect_any: ["sunlounger", "lounger", "Sola", "sun"]
    },
    {
      id: "FUZZY-004",
      name: "Dining intent",
      input: "want to eat outside with family",
      expect_any: ["dining", "table", "Dining", "Table", "eat"]
    }
  ],
  "seat_count": [
    {
      id: "SEAT-001",
      name: "2 people",
      input: "outdoor furniture for 2 people",
      expect_any: ["2", "two", "couple", "bistro"],
      must_not_contain: ["8 seater", "9 seater", "10 seater"]
    },
    {
      id: "SEAT-002",
      name: "4 people",
      input: "need seating for 4 guests",
      expect_any: ["4", "four"]
    },
    {
      id: "SEAT-003",
      name: "6 people",
      input: "furniture for family of 6",
      expect_any: ["6", "six"]
    },
    {
      id: "SEAT-004",
      name: "8+ people",
      input: "hosting big parties need 8 or more seats",
      expect_any: ["8", "9", "10", "eight", "nine", "ten"]
    }
  ],
  "material_questions": [
    {
      id: "MAT-001",
      name: "Durability concern",
      input: "will this furniture last outside?",
      expect_any: ["durable", "weather", "year", "last", "UV", "resistant"]
    },
    {
      id: "MAT-002",
      name: "Rattan longevity",
      input: "how long does rattan furniture last?",
      expect_any: ["20", "year", "polyrattan", "rattan", "UV"]
    },
    {
      id: "MAT-003",
      name: "Aluminium rust",
      input: "will aluminium furniture rust?",
      expect_any: ["rust", "powder", "coat", "resistant", "no", "doesn't", "won't"]
    }
  ],
  "weather_care": [
    {
      id: "WEATHER-001",
      name: "Rain concern",
      input: "can I leave furniture out in the rain?",
      expect_any: ["rain", "weather", "cover", "store", "yes", "outdoor"]
    },
    {
      id: "WEATHER-002",
      name: "Winter storage",
      input: "what do I do with furniture in winter?",
      expect_any: ["winter", "store", "cover", "indoor", "protect"]
    },
    {
      id: "WEATHER-003",
      name: "All year outside",
      input: "can polyrattan stay outside all year round?",
      expect_any: ["year", "outside", "cover", "yes", "recommend"]
    }
  ],
  "warranty_delivery": [
    {
      id: "WARRANTY-001",
      name: "Warranty question",
      input: "what warranty do you offer?",
      expect_any: ["warranty", "year", "guarantee", "1", "2", "3", "5", "10"]
    },
    {
      id: "DELIVERY-001",
      name: "Delivery time",
      input: "how long for delivery?",
      expect_any: ["5", "10", "day", "working", "delivery", "week"]
    },
    {
      id: "DELIVERY-002",
      name: "Assembly service",
      input: "can someone assemble for me?",
      expect_any: ["assembly", "service", "£69", "69.95"]
    }
  ],
  "upsell_bundles": [
    {
      id: "UPSELL-001",
      name: "Cover suggestion",
      input: "I want to buy the Faro lounge set",
      expect_any: ["Faro", "cover", "protect", "bundle", "20%", "save"]
    },
    {
      id: "UPSELL-002",
      name: "Bundle deals",
      input: "do you have any deals or bundles?",
      expect_any: ["bundle", "save", "20%", "discount", "deal"]
    }
  ],
  "specific_products": [
    {
      id: "PROD-001",
      name: "Faro details",
      input: "tell me about the Faro lounge set",
      expect_any: ["Faro", "9", "seat", "rattan"]
    },
    {
      id: "PROD-002",
      name: "Stockholm options",
      input: "what Stockholm sets do you have?",
      expect_any: ["Stockholm"]
    },
    {
      id: "PROD-003",
      name: "Barcelona info",
      input: "Barcelona lounge set features?",
      expect_any: ["Barcelona", "seat"]
    }
  ],
  "edge_cases": [
    {
      id: "EDGE-001",
      name: "Simple greeting",
      input: "hi",
      expect_any: ["help", "Hello", "Hi", "looking", "outdoor", "welcome"]
    },
    {
      id: "EDGE-002",
      name: "Price query",
      input: "how much is the Faro?",
      expect_any: ["£", "price", "Faro"]
    }
  ]
};

// ============================================
// TEST RUNNER FUNCTIONS
// ============================================

function checkTestResult(response, scenario) {
  const lowerResponse = response.toLowerCase();
  
  // Check expect_any (at least one term must be found)
  let expectAnyPassed = true;
  let foundTerms = [];
  let missingTerms = [];
  
  if (scenario.expect_any && scenario.expect_any.length > 0) {
    let anyFound = false;
    for (const term of scenario.expect_any) {
      if (lowerResponse.includes(term.toLowerCase())) {
        foundTerms.push(term);
        anyFound = true;
      } else {
        missingTerms.push(term);
      }
    }
    expectAnyPassed = anyFound;
  }
  
  // Check must_not_contain
  let mustNotPassed = true;
  let violations = [];
  
  if (scenario.must_not_contain && scenario.must_not_contain.length > 0) {
    for (const term of scenario.must_not_contain) {
      if (lowerResponse.includes(term.toLowerCase())) {
        violations.push(term);
        mustNotPassed = false;
      }
    }
  }
  
  return {
    passed: expectAnyPassed && mustNotPassed,
    foundTerms,
    missingTerms,
    violations,
    expectAnyPassed,
    mustNotPassed
  };
}

// ============================================
// TEST ENDPOINTS
// ============================================

// Full test suite
app.get('/run-tests', async (req, res) => {
  console.log('\n🧪 ═══════════════════════════════════════');
  console.log('🧪 STARTING GWEN TEST SUITE');
  console.log('🧪 ═══════════════════════════════════════\n');
  
  const results = {
    timestamp: new Date().toISOString(),
    summary: { total: 0, passed: 0, failed: 0, passRate: '0%' },
    suites: {}
  };
  
  for (const [suiteName, scenarios] of Object.entries(TEST_SCENARIOS)) {
    console.log(`\n📋 Suite: ${suiteName}`);
    results.suites[suiteName] = { total: 0, passed: 0, failed: 0, tests: [] };
    
    for (const scenario of scenarios) {
      console.log(`  🔄 ${scenario.id}: ${scenario.name}`);
      const startTime = Date.now();
      
      try {
        // Create fresh session for each test
        const testSessionId = `test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        
        // Build system prompt with empty session state
        const testSessionState = {
          messageCount: 1,
          established: {},
          commercial: {},
          availableSkus: []
        };
        const systemPrompt = buildSystemPrompt(testSessionState);
        
        const messages = [
          { role: "system", content: systemPrompt },
          { role: "user", content: scenario.input }
        ];
        
        // Call OpenAI
        const completion = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: messages,
          tools: aiTools,
          tool_choice: "auto",
          temperature: 0.4,
          max_tokens: 600
        });
        
        let response = completion.choices[0].message;
        let finalContent = response.content || '';
        
        // Handle tool calls if any
        if (response.tool_calls && response.tool_calls.length > 0) {
          const toolMessages = [...messages, response];
          
          for (const toolCall of response.tool_calls) {
            const funcName = toolCall.function.name;
            const args = JSON.parse(toolCall.function.arguments);
            
            let toolResult = { error: "Unknown function" };
            
            // Call the appropriate handler
            if (funcName === "search_products") {
              toolResult = searchProducts(args);
            } else if (funcName === "get_product_availability") {
              // Use your existing availability check
              const product = productIndex.bySku[args.sku];
              toolResult = product ? { 
                sku: args.sku, 
                available: true,
                stockLevel: product.stockStatus?.level || 'In Stock'
              } : { error: "Product not found" };
            } else if (funcName === "get_comprehensive_warranty") {
              const product = productIndex.bySku[args.sku];
              toolResult = product?.actual_warranties || { standard: "1 year guarantee" };
            } else if (funcName === "get_material_expertise") {
              toolResult = getMaterialExpertise ? getMaterialExpertise(args.material) : { info: "Material information" };
            }
            
            toolMessages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: JSON.stringify(toolResult)
            });
          }
          
          // Get final response
          const finalCompletion = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: toolMessages,
            temperature: 0.4,
            max_tokens: 600
          });
          
          finalContent = finalCompletion.choices[0].message.content || '';
        }
        
        const responseTime = Date.now() - startTime;
        const result = checkTestResult(finalContent, scenario);
        
        const testResult = {
          id: scenario.id,
          name: scenario.name,
          input: scenario.input,
          passed: result.passed,
          responseTime,
          response: finalContent.substring(0, 400) + (finalContent.length > 400 ? '...' : ''),
          found: result.foundTerms,
          missing: result.missingTerms,
          violations: result.violations
        };
        
        results.suites[suiteName].tests.push(testResult);
        results.suites[suiteName].total++;
        results.summary.total++;
        
        if (result.passed) {
          results.suites[suiteName].passed++;
          results.summary.passed++;
          console.log(`  ✅ PASSED (${responseTime}ms)`);
        } else {
          results.suites[suiteName].failed++;
          results.summary.failed++;
          console.log(`  ❌ FAILED (${responseTime}ms)`);
          if (result.missingTerms.length > 0 && result.foundTerms.length === 0) {
            console.log(`     None found from: ${scenario.expect_any.join(', ')}`);
          }
          if (result.violations.length > 0) {
            console.log(`     Violations: ${result.violations.join(', ')}`);
          }
        }
        
      } catch (error) {
        console.log(`  ❌ ERROR: ${error.message}`);
        results.suites[suiteName].tests.push({
          id: scenario.id,
          name: scenario.name,
          input: scenario.input,
          passed: false,
          error: error.message
        });
        results.suites[suiteName].total++;
        results.suites[suiteName].failed++;
        results.summary.total++;
        results.summary.failed++;
      }
      
      // Rate limit protection
      await new Promise(resolve => setTimeout(resolve, 800));
    }
  }
  
  // Calculate pass rate
  results.summary.passRate = results.summary.total > 0 
    ? ((results.summary.passed / results.summary.total) * 100).toFixed(1) + '%'
    : '0%';
  
  console.log(`\n🧪 ═══════════════════════════════════════`);
  console.log(`🧪 RESULTS: ${results.summary.passed}/${results.summary.total} (${results.summary.passRate})`);
  console.log(`🧪 ═══════════════════════════════════════\n`);
  
  // Return HTML or JSON
  if (req.query.format === 'json') {
    return res.json(results);
  }
  
  // Generate HTML report
  let html = generateTestReportHTML(results);
  res.send(html);
});

// Single test endpoint
app.get('/test-single', async (req, res) => {
  const input = req.query.input || req.query.q || 'outdoor furniture for 4 people';
  
  console.log(`\n🧪 Single test: "${input}"`);
  
  try {
    const systemPrompt = buildSystemPrompt ? buildSystemPrompt() : '';
    
    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: input }
    ];
    
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: messages,
      tools: aiTools,
      tool_choice: "auto",
      temperature: 0.4,
      max_tokens: 600
    });
    
    let response = completion.choices[0].message;
    let toolsCalled = [];
    let finalContent = response.content || '';
    
    if (response.tool_calls && response.tool_calls.length > 0) {
      const toolMessages = [...messages, response];
      
      for (const toolCall of response.tool_calls) {
        const funcName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);
        toolsCalled.push({ function: funcName, args });
        
        let toolResult = { error: "Unknown function" };
        
        if (funcName === "search_products") {
          toolResult = searchProducts(args);
        }
        
        toolMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(toolResult)
        });
      }
      
      const finalCompletion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: toolMessages,
        temperature: 0.4,
        max_tokens: 600
      });
      
      finalContent = finalCompletion.choices[0].message.content || '';
    }
    
    res.json({
      input,
      toolsCalled,
      response: finalContent
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// HTML Report Generator
function generateTestReportHTML(results) {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Gwen Test Results</title>
  <meta charset="UTF-8">
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; background: #f5f5f5; }
    .header { background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; padding: 30px; border-radius: 12px; margin-bottom: 20px; }
    .header h1 { margin: 0 0 10px 0; }
    .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin-bottom: 20px; }
    .stat { background: white; padding: 20px; border-radius: 10px; text-align: center; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .stat h3 { margin: 0 0 8px 0; color: #666; font-size: 12px; text-transform: uppercase; }
    .stat .value { font-size: 32px; font-weight: bold; }
    .passed { color: #10b981; }
    .failed { color: #ef4444; }
    .suite { background: white; border-radius: 10px; margin-bottom: 15px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .suite-header { padding: 15px 20px; background: #f8fafc; border-bottom: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center; }
    .suite-name { font-weight: 600; text-transform: uppercase; font-size: 14px; }
    .suite-stats { font-size: 14px; color: #666; }
    .test { padding: 12px 20px; border-bottom: 1px solid #f1f5f9; }
    .test:last-child { border-bottom: none; }
    .test-row { display: flex; align-items: center; gap: 12px; cursor: pointer; }
    .test-status { width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; flex-shrink: 0; }
    .test-status.pass { background: #dcfce7; color: #10b981; }
    .test-status.fail { background: #fee2e2; color: #ef4444; }
    .test-info { flex: 1; }
    .test-id { font-weight: 600; font-size: 13px; }
    .test-name { color: #666; font-size: 13px; }
    .test-time { color: #999; font-size: 12px; }
    .test-details { display: none; margin-top: 12px; padding: 12px; background: #f8fafc; border-radius: 8px; font-size: 13px; }
    .test-details.show { display: block; }
    .detail-row { margin-bottom: 8px; }
    .detail-label { font-weight: 600; color: #374151; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; margin: 2px; }
    .badge.found { background: #dcfce7; color: #15803d; }
    .badge.missing { background: #fef3c7; color: #b45309; }
    .badge.violation { background: #fee2e2; color: #b91c1c; }
    .response-text { background: white; padding: 10px; border-radius: 6px; margin-top: 8px; white-space: pre-wrap; font-size: 12px; color: #374151; max-height: 200px; overflow-y: auto; }
    .actions { margin-top: 20px; text-align: center; }
    .btn { display: inline-block; padding: 10px 20px; background: #10b981; color: white; text-decoration: none; border-radius: 6px; margin: 5px; }
    .btn:hover { background: #059669; }
  </style>
</head>
<body>
  <div class="header">
    <h1>🧪 Gwen Test Results</h1>
    <p>Run at: ${results.timestamp}</p>
  </div>
  
  <div class="summary">
    <div class="stat">
      <h3>Total Tests</h3>
      <div class="value">${results.summary.total}</div>
    </div>
    <div class="stat">
      <h3>Passed</h3>
      <div class="value passed">${results.summary.passed}</div>
    </div>
    <div class="stat">
      <h3>Failed</h3>
      <div class="value failed">${results.summary.failed}</div>
    </div>
    <div class="stat">
      <h3>Pass Rate</h3>
      <div class="value" style="color: ${parseFloat(results.summary.passRate) >= 70 ? '#10b981' : '#ef4444'}">${results.summary.passRate}</div>
    </div>
  </div>
  
  ${Object.entries(results.suites).map(([suiteName, suite]) => `
  <div class="suite">
    <div class="suite-header">
      <span class="suite-name">${suiteName.replace(/_/g, ' ')}</span>
      <span class="suite-stats">${suite.passed}/${suite.total} passed</span>
    </div>
    ${suite.tests.map(test => `
    <div class="test">
      <div class="test-row" onclick="this.nextElementSibling.classList.toggle('show')">
        <div class="test-status ${test.passed ? 'pass' : 'fail'}">${test.passed ? '✓' : '✗'}</div>
        <div class="test-info">
          <span class="test-id">${test.id}</span>
          <span class="test-name">- ${test.name}</span>
        </div>
        <span class="test-time">${test.responseTime || 0}ms</span>
      </div>
      <div class="test-details">
        <div class="detail-row">
          <span class="detail-label">Input:</span> "${test.input}"
        </div>
        ${test.found && test.found.length > 0 ? `
        <div class="detail-row">
          <span class="detail-label">Found:</span>
          ${test.found.map(t => `<span class="badge found">${t}</span>`).join('')}
        </div>
        ` : ''}
        ${test.missing && test.missing.length > 0 && (!test.found || test.found.length === 0) ? `
        <div class="detail-row">
          <span class="detail-label">Expected one of:</span>
          ${test.missing.map(t => `<span class="badge missing">${t}</span>`).join('')}
        </div>
        ` : ''}
        ${test.violations && test.violations.length > 0 ? `
        <div class="detail-row">
          <span class="detail-label">Violations:</span>
          ${test.violations.map(t => `<span class="badge violation">${t}</span>`).join('')}
        </div>
        ` : ''}
        ${test.error ? `
        <div class="detail-row">
          <span class="detail-label" style="color: #ef4444;">Error:</span> ${test.error}
        </div>
        ` : ''}
        ${test.response ? `
        <div class="detail-row">
          <span class="detail-label">Response:</span>
          <div class="response-text">${test.response.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
        </div>
        ` : ''}
      </div>
    </div>
    `).join('')}
  </div>
  `).join('')}
  
  <div class="actions">
    <a href="/run-tests" class="btn">🔄 Run Again</a>
    <a href="/run-tests?format=json" class="btn">📊 JSON Results</a>
    <a href="/test-single?input=I need 6 seater rattan furniture" class="btn">🧪 Test Single</a>
  </div>
</body>
</html>`;
}

// ============================================
// SERVER STARTUP
// ============================================

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🚀 GWEN v14.0 - Conversation + Server Rendering`);
    console.log(`   Products: ${Object.keys(productIndex.bySku).length}`);
    console.log(`   Inventory: ${inventoryData.length} records`);
    console.log(`   OpenAI: ${process.env.OPENAI_API_KEY ? '✅' : '❌'}`);
    console.log(`   Shopify: ${SHOPIFY_ACCESS_TOKEN ? '✅' : '⚠️'}`);
    console.log(`${'='.repeat(60)}\n`);
});

module.exports = app;
