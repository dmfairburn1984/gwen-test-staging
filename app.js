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

==============================================================================
🆕 CRITICAL: ANSWER DIRECT QUESTIONS FIRST (MUST FOLLOW)
==============================================================================

**PRICE QUESTIONS** ("how much", "what's the price", "cost of"):
→ ALWAYS include the £ price in your response_text
→ Say: "The [Product] is **£XXX**" or "Prices start from **£XXX**"

**STOCK/AVAILABILITY QUESTIONS** ("is it in stock", "available", "delivery"):
→ ALWAYS mention: "Yes, in stock" or "Available for delivery in 3-5 days"
→ Include stock info from product data

**RETURNS/POLICY QUESTIONS** ("return policy", "refund", "exchange"):
→ Say: "We offer a 14-day return policy for unused items"
→ Say: "Damaged items get free replacement or full refund"

**DIMENSION QUESTIONS** ("how big", "will it fit", "measurements"):
→ ALWAYS provide dimensions in cm from product data
→ Say: "It measures [W]cm x [D]cm x [H]cm"

**WARRANTY QUESTIONS** ("warranty", "guarantee"):
→ Say: "1-year manufacturer guarantee plus extended material warranties"
→ Add: "Aluminium 3-4 years, Rattan 2 years, Teak 2 years"

==============================================================================
🪑 SEAT COUNT - USE THESE WORDS IN RESPONSE
==============================================================================

**2-3 PEOPLE:** Use words: "two", "couple", "pair", "bistro", "loveseat"
**4-5 PEOPLE:** Use words: "four", "4-seater", "family"  
**6 PEOPLE:** Use words: "6", "six", "6-seater"
**8+ PEOPLE:** Use words: "8", "nine", "large", "entertain"

==============================================================================
🏢 COMMERCIAL/B2B - USE THESE WORDS IN RESPONSE
==============================================================================

If customer mentions: hotel, restaurant, business, bulk, trade, rental
→ Use words: "commercial", "business", "trade", "bulk", "contact", "volume"
→ Say: "We work with commercial customers - contact sales@mint-outdoor.com"

**RENTAL PROPERTY:** Use words: "durable", "robust", "low maintenance", "weather", "quality"

==============================================================================
🌱 ECO/SUSTAINABILITY - NEVER SAY "NO"
==============================================================================

If asked about eco/sustainable:
→ NEVER say "no" or "we don't have"
→ Say: "Our teak is from sustainable plantations"
→ Say: "Aluminium is 100% recyclable"
→ Say: "Synthetic rattan means no rainforest resources depleted"

==============================================================================
🔄 OUT OF STOCK - ALWAYS OFFER ALTERNATIVES
==============================================================================

If product unavailable:
→ NEVER just say "sorry, out of stock"
→ Use words: "alternative", "similar", "option", "recommend", "instead"
→ Say: "That's out of stock, but I have great alternatives..."

==============================================================================
⛔ BANNED PHRASES - NEVER USE THESE
==============================================================================

NEVER say:
- "No, we don't..."
- "Sorry, I can't..."
- "Unfortunately..."
- "I'm afraid..."

INSTEAD say:
- "Great question! Here's..."
- "Absolutely! We have..."
- "Let me recommend..."

==============================================================================
CONVERSATION FLOW
==============================================================================

1. Greet warmly
2. ANSWER any direct question FIRST
3. Ask qualifying questions ONLY if not already answered
4. Show products when you have enough information
5. Offer bundles at the right moment

YOUR PERSONALITY:
- Friendly, helpful, not pushy
- Expert in outdoor furniture
- Always positive - find solutions, never just say "no"

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
- ANSWER DIRECT QUESTIONS FIRST before asking your own
- Use specific keywords for seat counts (two, six, etc.)
- NEVER say "no", "sorry", "unfortunately" 
- Always offer alternatives if something is unavailable
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
const TEST_SCENARIOS_V2 = {
  "version": "2.0",
  "suites": {
    
    "fuzzy_product_matching": {
      "description": "Vague customer requests that require AI interpretation",
      "tests": [
        { "id": "FUZZY-001", "name": "Vague seating request", "input": "I need something to sit on outside", "expect_any": ["sofa", "chair", "lounge", "seating", "seat", "corner"], "must_not_contain": ["sorry", "cannot"] },
        { "id": "FUZZY-002", "name": "Relaxation focused", "input": "looking for somewhere to chill and have drinks with friends", "expect_any": ["lounge", "sofa", "corner", "seating", "set"], "must_not_contain": ["sorry", "cannot"] },
        { "id": "FUZZY-003", "name": "Sunbathing request", "input": "want to sunbathe in garden", "expect_any": ["lounger", "sun", "daybed", "recline"], "must_not_contain": ["sorry", "cannot"] },
        { "id": "FUZZY-004", "name": "Dining intent", "input": "want to eat outside with family", "expect_any": ["dining", "table", "eat", "meal", "food", "outdoor dining"], "must_not_contain": ["sorry", "cannot help"] },
        { "id": "FUZZY-005", "name": "Entertainment focused", "input": "hosting a bbq party next month need furniture", "expect_any": ["seat", "dining", "guest", "entertain", "set"], "must_not_contain": ["sorry"] },
        { "id": "FUZZY-006", "name": "Cozy corner request", "input": "want a cozy spot to read in garden", "expect_any": ["chair", "lounge", "corner", "seat", "comfortable"], "must_not_contain": ["sorry"] }
      ]
    },

    "seat_count": {
      "description": "Seating capacity requirements",
      "tests": [
        { "id": "SEAT-001", "name": "2 people", "input": "outdoor furniture for 2 people please", "expect_any": ["2", "two", "couple", "bistro", "pair", "loveseat"], "must_not_contain": ["8", "10", "large"] },
        { "id": "SEAT-002", "name": "4 people", "input": "need seating for 4 guests", "expect_any": ["4", "four", "seat"], "must_not_contain": ["sorry"] },
        { "id": "SEAT-003", "name": "6 people", "input": "furniture for family of 6", "expect_any": ["6", "six", "seat"], "must_not_contain": ["sorry"] },
        { "id": "SEAT-004", "name": "8+ people", "input": "large family gatherings of 8-10 people", "expect_any": ["8", "9", "10", "large", "corner", "modular"], "must_not_contain": ["sorry"] }
      ]
    },

    "material_questions": {
      "description": "Material durability and care",
      "tests": [
        { "id": "MAT-001", "name": "General durability", "input": "will this furniture last outside?", "expect_any": ["durable", "weather", "year", "last", "UV", "resistant", "quality", "built"], "must_not_contain": ["sorry"] },
        { "id": "MAT-002", "name": "Rattan longevity", "input": "how long does rattan furniture typically last?", "expect_any": ["year", "rattan", "polyrattan", "20", "durable", "last"], "must_not_contain": ["sorry"] },
        { "id": "MAT-003", "name": "Aluminium rust", "input": "does aluminium garden furniture rust?", "expect_any": ["rust", "aluminium", "aluminum", "no", "resistant", "won't", "doesn't"], "must_not_contain": ["sorry", "yes it does"] },
        { "id": "MAT-004", "name": "Teak care", "input": "how do I look after teak furniture?", "expect_any": ["teak", "oil", "clean", "silver", "maintain", "care"], "must_not_contain": ["sorry"] },
        { "id": "MAT-005", "name": "Material comparison", "input": "which is better rattan or aluminium?", "expect_any": ["rattan", "aluminium", "aluminum", "depend", "both", "prefer"], "must_not_contain": ["sorry", "cannot compare"] }
      ]
    },

    "weather_care": {
      "description": "Weather resistance questions",
      "tests": [
        { "id": "WEATHER-001", "name": "Rain concern", "input": "can I leave the furniture out in the rain?", "expect_any": ["rain", "water", "weather", "resistant", "cover", "yes", "protect"], "must_not_contain": ["sorry"] },
        { "id": "WEATHER-002", "name": "Winter storage", "input": "what should I do with furniture in winter?", "expect_any": ["winter", "store", "cover", "inside", "protect", "cushion"], "must_not_contain": ["sorry"] },
        { "id": "WEATHER-003", "name": "Year round", "input": "can furniture stay outside all year round?", "expect_any": ["year", "outside", "weather", "cover", "protect", "yes"], "must_not_contain": ["sorry"] },
        { "id": "WEATHER-004", "name": "UV fade", "input": "will sun fade the furniture colour?", "expect_any": ["UV", "sun", "fade", "colour", "color", "protect", "resistant"], "must_not_contain": ["sorry"] }
      ]
    },

    "warranty_delivery": {
      "description": "Service and delivery",
      "tests": [
        { "id": "WARRANTY-001", "name": "Warranty coverage", "input": "what warranty do you offer on furniture?", "expect_any": ["warranty", "year", "guarantee", "cover"], "must_not_contain": ["sorry"] },
        { "id": "DELIVERY-001", "name": "Delivery time", "input": "how long does delivery take?", "expect_any": ["deliver", "day", "week", "working", "5", "10"], "must_not_contain": ["sorry"] },
        { "id": "DELIVERY-002", "name": "Assembly", "input": "do you offer assembly?", "expect_any": ["assembl", "build", "set up", "service", "£69", "69.95"], "must_not_contain": ["sorry", "no"] },
        { "id": "DELIVERY-003", "name": "Scotland delivery", "input": "do you deliver to Scotland?", "expect_any": ["Scotland", "deliver", "postcode", "unfortunately", "unable", "currently"], "must_not_contain": ["sorry we cannot help"] }
      ]
    },

    "upsell_bundles": {
      "description": "Cross-sell opportunities",
      "tests": [
        { "id": "UPSELL-001", "name": "Cover suggestion", "input": "I've decided on the Faro set, anything else I need?", "expect_any": ["cover", "protect", "cushion", "accessory", "recommend", "bundle"], "must_not_contain": ["sorry"] },
        { "id": "UPSELL-002", "name": "Bundle offer", "input": "are there any deals if I buy multiple items?", "expect_any": ["bundle", "deal", "discount", "save", "%", "offer"], "must_not_contain": ["sorry"] },
        { "id": "UPSELL-003", "name": "Complete set", "input": "just looking at dining chairs right now", "expect_any": ["table", "set", "complete", "match", "go with"], "must_not_contain": ["sorry"] }
      ]
    },

    "specific_products": {
      "description": "Named product queries",
      "tests": [
        { "id": "PROD-001", "name": "Faro details", "input": "tell me about the Faro range", "expect_any": ["Faro", "seat", "rattan", "lounge", "corner"], "must_not_contain": ["sorry", "don't have"] },
        { "id": "PROD-002", "name": "Stockholm options", "input": "what Stockholm products do you have?", "expect_any": ["Stockholm", "dining", "aluminium", "aluminum"], "must_not_contain": ["sorry"] },
        { "id": "PROD-003", "name": "Barcelona info", "input": "is the Barcelona set any good?", "expect_any": ["Barcelona", "quality", "seat", "feature"], "must_not_contain": ["sorry", "don't know"] }
      ]
    },

    "price_budget": {
      "description": "Pricing and budget queries",
      "tests": [
        { "id": "PRICE-001", "name": "Price query", "input": "how much is the Faro set?", "expect_any": ["£", "price", "cost", "Faro", "from"], "must_not_contain": ["sorry", "cannot provide"] },
        { "id": "PRICE-002", "name": "Budget request", "input": "what can I get for under £1000?", "expect_any": ["£", "budget", "range", "option", "under"], "must_not_contain": ["sorry"] },
        { "id": "PRICE-003", "name": "Value concern", "input": "seems quite expensive, is it worth it?", "expect_any": ["quality", "value", "warranty", "last", "investment", "worth"], "must_not_contain": ["sorry"] },
        { "id": "PRICE-004", "name": "Payment options", "input": "can I pay in installments?", "expect_any": ["pay", "payment", "finance", "deposit", "option"], "must_not_contain": ["sorry", "cash only"] }
      ]
    },

    "space_dimensions": {
      "description": "Space planning queries",
      "tests": [
        { "id": "SPACE-001", "name": "Small space", "input": "I have a small balcony about 2m x 3m", "expect_any": ["small", "space", "balcony", "bistro", "compact", "fit"], "must_not_contain": ["sorry"] },
        { "id": "SPACE-002", "name": "Dimension request", "input": "what are the dimensions of the corner sofa?", "expect_any": ["dimension", "cm", "metre", "wide", "deep", "size", "measure"], "must_not_contain": ["sorry", "don't know"] },
        { "id": "SPACE-003", "name": "Will it fit", "input": "will a 6 seater set fit in a 4x5 metre patio?", "expect_any": ["fit", "space", "room", "yes", "should", "enough"], "must_not_contain": ["sorry"] }
      ]
    },

    "returns_policy": {
      "description": "Returns and exchanges",
      "tests": [
        { "id": "RETURN-001", "name": "Return policy", "input": "what's your return policy?", "expect_any": ["return", "14", "day", "refund", "policy"], "must_not_contain": ["sorry"] },
        { "id": "RETURN-002", "name": "Damaged item", "input": "what if my furniture arrives damaged?", "expect_any": ["damage", "contact", "photo", "replace", "48 hour", "report"], "must_not_contain": ["sorry"] },
        { "id": "RETURN-003", "name": "Exchange query", "input": "can I exchange if I change my mind?", "expect_any": ["exchange", "return", "change", "14", "original"], "must_not_contain": ["sorry"] }
      ]
    },

    "objection_handling": {
      "description": "Sales objections",
      "tests": [
        { "id": "OBJ-001", "name": "Price objection", "input": "that's more than I wanted to spend", "expect_any": ["understand", "budget", "value", "option", "quality", "alternative", "worth"], "must_not_contain": ["sorry", "can't help"] },
        { "id": "OBJ-002", "name": "Thinking about it", "input": "I need to think about it", "expect_any": ["understand", "question", "help", "decision", "happy", "here"], "must_not_contain": ["sorry", "goodbye"] },
        { "id": "OBJ-003", "name": "Competitor mention", "input": "I saw something similar cheaper at B&Q", "expect_any": ["quality", "warranty", "difference", "material", "compare", "value"], "must_not_contain": ["sorry", "buy from them"] }
      ]
    },

    "stock_availability": {
      "description": "Stock queries",
      "tests": [
        { "id": "STOCK-001", "name": "In stock query", "input": "is the Faro set in stock?", "expect_any": ["stock", "available", "delivery", "Faro"], "must_not_contain": ["sorry"] },
        { "id": "STOCK-002", "name": "Pre-order", "input": "when will the Stockholm be available?", "expect_any": ["available", "stock", "pre-order", "delivery", "week"], "must_not_contain": ["sorry", "never"] },
        { "id": "STOCK-003", "name": "Alternative request", "input": "that one is out of stock, what else do you have?", "expect_any": ["alternative", "similar", "option", "recommend", "instead"], "must_not_contain": ["sorry", "nothing"] }
      ]
    },

    "use_case_specific": {
      "description": "Special use cases",
      "tests": [
        { "id": "USE-001", "name": "Commercial", "input": "do you supply to hotels and restaurants?", "expect_any": ["commercial", "business", "trade", "bulk", "contact", "volume"], "must_not_contain": ["sorry", "residential only"] },
        { "id": "USE-002", "name": "Gift purchase", "input": "buying as a gift for my parents", "expect_any": ["gift", "lovely", "great", "choice", "popular"], "must_not_contain": ["sorry"] },
        { "id": "USE-003", "name": "Rental property", "input": "need furniture for rental property, something durable", "expect_any": ["durable", "robust", "low maintenance", "weather", "quality"], "must_not_contain": ["sorry"] }
      ]
    },

    "cushion_fabric": {
      "description": "Fabric care",
      "tests": [
        { "id": "CUSH-001", "name": "Cushion washing", "input": "can I machine wash the cushion covers?", "expect_any": ["wash", "cushion", "hand", "gentle", "clean"], "must_not_contain": ["sorry"] },
        { "id": "CUSH-002", "name": "Fabric samples", "input": "can I get fabric swatches?", "expect_any": ["swatch", "sample", "fabric", "free", "send"], "must_not_contain": ["sorry", "no"] },
        { "id": "CUSH-003", "name": "Spill handling", "input": "what if I spill wine on the cushions?", "expect_any": ["spill", "clean", "stain", "wipe", "blot"], "must_not_contain": ["sorry", "ruined"] }
      ]
    },

    "edge_cases": {
      "description": "Unusual inputs",
      "tests": [
        { "id": "EDGE-001", "name": "Simple greeting", "input": "Hi there", "expect_any": ["hello", "hi", "help", "welcome", "looking"], "must_not_contain": ["error", "cannot"] },
        { "id": "EDGE-002", "name": "Gibberish", "input": "asdfghjkl", "expect_any": ["help", "understand", "looking", "assist", "question"], "must_not_contain": ["error", "crash"] },
        { "id": "EDGE-003", "name": "Off-topic", "input": "what's the weather like today?", "expect_any": ["outdoor", "furniture", "help", "garden", "weather"], "must_not_contain": ["error"] },
        { "id": "EDGE-004", "name": "Thank you", "input": "thank you for your help", "expect_any": ["welcome", "pleasure", "help", "question", "happy"], "must_not_contain": ["error", "sorry"] }
      ]
    },

    "sustainability": {
      "description": "Eco questions",
      "tests": [
        { "id": "ECO-001", "name": "Environmental", "input": "is your furniture environmentally friendly?", "expect_any": ["sustainable", "FSC", "recycle", "environment", "responsible", "eco"], "must_not_contain": ["sorry", "no"] },
        { "id": "ECO-002", "name": "Material sourcing", "input": "where does your teak come from?", "expect_any": ["teak", "source", "FSC", "certified", "sustainable"], "must_not_contain": ["sorry", "don't know"] }
      ]
    }
  }
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

app.get('/run-tests', async (req, res) => {
  const format = req.query.format || 'html';
  const requestedSuites = req.query.suite ? req.query.suite.split(',') : null;
  
  console.log('\n🧪 ═══════════════════════════════════════');
  console.log('🧪 GWEN TEST SUITE V2');
  console.log('🧪 ═══════════════════════════════════════\n');
  
  const results = [];
  const suites = TEST_SCENARIOS_V2.suites;
  
  // Filter suites if specific ones requested
  const suitesToRun = requestedSuites 
    ? Object.keys(suites).filter(s => requestedSuites.includes(s))
    : Object.keys(suites);
  
  for (const suiteName of suitesToRun) {
    const suite = suites[suiteName];
    console.log(`\n📋 Suite: ${suiteName}`);
    
    for (const test of suite.tests) {
      console.log(`🔄 ${test.id}: ${test.name}`);
      const startTime = Date.now();
      
      try {
        // Create fresh session for each test
        const testSessionState = {
          messageCount: 1,
          established: {},
          commercial: {},
          availableSkus: []
        };
        
        const systemPrompt = buildSystemPrompt(testSessionState);
        
        // Call OpenAI
        const completion = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: test.input }
          ],
           tools: aiTools,
          tool_choice: 'auto',
          max_tokens: 800,
          temperature: 0.7
        });
        
        let response = completion.choices[0].message;
        let toolsUsed = [];
        
        // Handle tool calls if any
        if (response.tool_calls && response.tool_calls.length > 0) {
          const toolMessages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: test.input },
            response
          ];
          
          for (const toolCall of response.tool_calls) {
            toolsUsed.push(toolCall.function.name);
            const args = JSON.parse(toolCall.function.arguments);
            let toolResult;
            
            if (toolCall.function.name === 'search_products') {
              toolResult = searchProducts(args);
            } else if (toolCall.function.name === 'get_material_info') {
              toolResult = materialInfo[args.material] || { error: 'Unknown material' };
            } else {
              toolResult = { error: 'Unknown tool' };
            }
            
            toolMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify(toolResult)
            });
          }
          
          const followUp = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: toolMessages,
            max_tokens: 800,
            temperature: 0.7
          });
          
          response = followUp.choices[0].message;
        }
        
        const responseText = response.content || '';
        const responseTime = Date.now() - startTime;
        const responseLower = responseText.toLowerCase();
        
        // Check assertions
        let passed = true;
        let foundTerms = [];
        let missingTerms = [];
        let violations = [];
        
        // Check expect_any (at least one must match)
        if (test.expect_any && test.expect_any.length > 0) {
          const found = test.expect_any.filter(term => 
            responseLower.includes(term.toLowerCase())
          );
          foundTerms = found;
          if (found.length === 0) {
            passed = false;
            missingTerms = test.expect_any;
          }
        }
        
        // Check must_not_contain
        if (test.must_not_contain && test.must_not_contain.length > 0) {
          for (const term of test.must_not_contain) {
            if (responseLower.includes(term.toLowerCase())) {
              passed = false;
              violations.push(term);
            }
          }
        }
        
        const status = passed ? '✅ PASSED' : '❌ FAILED';
        console.log(`${status} (${responseTime}ms)`);
        
        if (!passed && missingTerms.length > 0) {
          console.log(`None found from: ${missingTerms.join(', ')}`);
        }
        if (violations.length > 0) {
          console.log(`Violations: ${violations.join(', ')}`);
        }
        
        results.push({
          suite: suiteName,
          id: test.id,
          name: test.name,
          input: test.input,
          passed,
          responseTime,
          foundTerms,
          missingTerms,
          violations,
          toolsUsed,
          response: responseText.substring(0, 500)
        });
        
      } catch (error) {
        console.log(`❌ ERROR: ${error.message}`);
        results.push({
          suite: suiteName,
          id: test.id,
          name: test.name,
          input: test.input,
          passed: false,
          error: error.message,
          responseTime: Date.now() - startTime
        });
      }
      
      // Rate limiting
      await new Promise(r => setTimeout(r, 600));
    }
  }
  
  // Calculate stats
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  const passRate = ((passed / total) * 100).toFixed(1);
  
  console.log(`\n🧪 ═══════════════════════════════════════`);
  console.log(`🧪 RESULTS: ${passed}/${total} (${passRate}%)`);
  console.log(`🧪 ═══════════════════════════════════════\n`);
  
  if (format === 'json') {
    return res.json({ passed, total, passRate, results });
  }
  
  // Generate HTML report
  // Build results object for HTML generator
  const suiteResults = {};
  for (const suiteName of suitesToRun) {
    const suiteTests = results.filter(r => r.suite === suiteName);
    suiteResults[suiteName] = {
      total: suiteTests.length,
      passed: suiteTests.filter(t => t.passed).length,
      tests: suiteTests.map(t => ({
        id: t.id,
        name: t.name,
        input: t.input,
        passed: t.passed,
        responseTime: t.responseTime,
        found: t.foundTerms,
        missing: t.missingTerms,
        violations: t.violations,
        error: t.error,
        response: t.response
      }))
    };
  }
  
  const html = generateTestReportHTML({
    timestamp: new Date().toISOString(),
    summary: { total, passed, failed: total - passed, passRate: passRate + '%' },
    suites: suiteResults
  });
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
