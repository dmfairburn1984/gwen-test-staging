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
    
    // Filter by seat count - STRICT MINIMUM, no irrelevant smaller products
    if (seatCount) {
        const target = parseInt(seatCount);
        const beforeCount = filtered.length;
        
        // First, try to find products that meet the seat requirement
        const matchingProducts = filtered.filter(p => {
            const seats = parseInt(p.specifications?.seats);
            return seats && seats >= target;
        });
        
        console.log(`🔍 After seat filter (>=${target}): ${matchingProducts.length} products (was ${beforeCount})`);
        
        if (matchingProducts.length > 0) {
            // Sort by closest match to requested seats (not oversized)
            matchingProducts.sort((a, b) => {
                const seatsA = parseInt(a.specifications?.seats) || 0;
                const seatsB = parseInt(b.specifications?.seats) || 0;
                return seatsA - seatsB; // Prefer closer matches
            });
            filtered = matchingProducts;
        } else {
            // No exact matches - find the LARGEST available and warn
            console.log(`   ⚠️ No products with ${target}+ seats, finding largest available`);
            
            // Get products with seat counts, sorted by seats descending
            const productsWithSeats = filtered.filter(p => {
                const seats = parseInt(p.specifications?.seats);
                return seats && seats > 0;
            }).sort((a, b) => {
                return (parseInt(b.specifications?.seats) || 0) - (parseInt(a.specifications?.seats) || 0);
            });
            
            if (productsWithSeats.length > 0) {
                const maxSeats = parseInt(productsWithSeats[0].specifications?.seats);
                // Only show products with the maximum available seats (or close to it)
                filtered = productsWithSeats.filter(p => {
                    const seats = parseInt(p.specifications?.seats);
                    return seats >= maxSeats - 1; // Allow 1 seat tolerance
                });
                console.log(`   📊 Showing ${filtered.length} products with ${maxSeats} seats (largest available)`);
            } else {
                filtered = [];
            }
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
    // Build concise context summary
    const ctx = sessionState.established || {};
    const contextParts = [];
    if (ctx.furnitureType) contextParts.push(`Looking for: ${ctx.furnitureType} furniture`);
    if (ctx.seatCount) contextParts.push(`Seats needed: ${ctx.seatCount}+`);
    if (ctx.material) contextParts.push(`Material: ${ctx.material}`);
    
    const contextSummary = contextParts.length > 0 
        ? contextParts.join(' | ') 
        : "New customer - no preferences established yet";
    
    // Track commercial state
    const commercial = sessionState.commercial || {};
    const commercialState = [];
    if (commercial.productsShown?.length > 0) {
        commercialState.push(`Products shown: ${commercial.productsShown.length}`);
    }
    if (commercial.sentiment === 'price_concerned') {
        commercialState.push("⚠️ Customer is price-sensitive - NO UPSELLS");
    }
    if (commercial.bundleDeclined) {
        commercialState.push("⚠️ Bundle declined - don't offer again");
    }
    
    return `You are Gwen, a friendly sales assistant for MINT Outdoor furniture. You help customers find perfect outdoor furniture.

═══════════════════════════════════════════════════════════
CURRENT CUSTOMER CONTEXT
═══════════════════════════════════════════════════════════
${contextSummary}
${commercialState.length > 0 ? '\nCommercial notes: ' + commercialState.join(' | ') : ''}
═══════════════════════════════════════════════════════════

YOUR CORE RULES:
1. REMEMBER what customer already told you - don't ask again
2. ANSWER direct questions FIRST, then ask follow-ups
3. When showing products, output SKUs only - server renders the cards
4. Be warm and helpful, never say "no" or "unfortunately"

WHEN TO SHOW PRODUCTS (use product_recommendation intent):
- Customer mentions material (rattan, teak, aluminium) AND furniture type or size
- Customer asks to see options or alternatives
→ Only show products if you have 2+ pieces of qualifying information

WHEN NOT TO SHOW PRODUCTS:
- Customer says "I like it", "that's great", "perfect" → They've chosen! Help them buy, don't show more
- Customer asks "how do I order" or "how to buy" → Give checkout instructions, don't show products
- Customer says "yes" to your question → Acknowledge and help them proceed, don't restart

WHEN CUSTOMER IS READY TO BUY:
If customer says: "I'll take it", "how do I order", "how to buy", "yes I want it", "let's do it"
→ Use the initiate_checkout tool OR give clear ordering instructions:
   1. Tell them to click the View Product button
   2. Add to basket on our website
   3. Proceed to checkout
   4. Mention any bundle discount if applicable

WHEN CUSTOMER WANTS EMAIL QUOTE:
If customer provides email or asks you to email details:
→ Use the capture_email_for_quote tool
→ Confirm you'll send details within a few minutes

WHEN TO ASK QUESTIONS (use clarification intent):
- Only 1 piece of info known - ask for furniture type or size
- Never ask what they already told you
- NEVER ask "would you like these?" after they already said yes

RESPONDING TO SPECIFIC QUESTIONS:
- Price: "The [Product] is **£XXX**" - always include the pound amount
- Stock: "Yes, it's in stock with 3-5 day delivery"
- Warranty: "We offer 1-year guarantee plus extended material warranties"
- Dimensions: Include W x D x H in cm
- Eco questions: "Our teak is from sustainable plantations, aluminium is 100% recyclable"
- Commercial/B2B: "We work with businesses - contact sales@mint-outdoor.com for volume pricing"

═══════════════════════════════════════════════════════════
OUTPUT FORMAT - ALWAYS VALID JSON
═══════════════════════════════════════════════════════════

For conversation only (no products):
{
    "intent": "greeting" | "clarification" | "question_answer",
    "response_text": "Your friendly response here"
}

For showing products:
{
    "intent": "product_recommendation",
    "intro_copy": "Brief intro (1 sentence)",
    "selected_skus": ["SKU-1", "SKU-2"],
    "personalisation": "Brief personalisation",
    "closing_copy": "Which style catches your eye?"
}

═══════════════════════════════════════════════════════════
AVAILABLE PRODUCT SKUs (only use these):
${sessionState.availableSkus?.length > 0 
    ? sessionState.availableSkus.join(', ') 
    : 'Call search_products first to find products'}
═══════════════════════════════════════════════════════════

Remember: Output ONLY valid JSON. No markdown, no code blocks, just the JSON object.`;
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
    },
    {
        type: "function",
        function: {
            name: "capture_email_for_quote",
            description: "Capture customer email to send them a quote or product summary. Use when customer provides their email address or asks you to email them details.",
            parameters: {
                type: "object",
                properties: {
                    email: {
                        type: "string",
                        description: "Customer's email address"
                    },
                    productSkus: {
                        type: "array",
                        items: { type: "string" },
                        description: "SKUs of products to include in quote"
                    },
                    includeBundle: {
                        type: "boolean",
                        description: "Whether to include bundle pricing"
                    }
                },
                required: ["email"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "initiate_checkout",
            description: "Help customer proceed to checkout. Use when customer says they want to buy, order, purchase, or asks how to complete their order.",
            parameters: {
                type: "object",
                properties: {
                    productSku: {
                        type: "string",
                        description: "SKU of main product to purchase"
                    },
                    includeBundle: {
                        type: "boolean",
                        description: "Whether customer wants the bundle deal"
                    }
                },
                required: ["productSku"]
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
// COMMERCE GOVERNANCE ENGINE
// ============================================

const COMMERCE_RULES = {
    bundle: {
        maxOffersPerSession: 3,
        discountPercent: 20,
        stopAfterDecline: true,
        firstOfferType: 'soft', // 'soft' = just mention, 'detailed' = full pricing
        requireInterestForDetailed: true
    },
    upsell: {
        maxPerSession: 2,
        maxPriceIncrease: 0.5, // 50%
        requirePositiveSignal: true,
        stopIfPriceConcerned: true,
        stopAfterDecline: true
    },
    crossSell: {
        priority: ['cover', 'cushion_box', 'replacement_cushions', 'assembly'],
        maxPerProduct: 2,
        assemblyPrice: 99.95
    }
};

function buildStateSummary(session) {
    const ctx = session.context;
    const commercial = session.commercial;
    
    let summary = "=== CONVERSATION STATE ===\n";
    
    // Customer preferences
    if (ctx.material || ctx.furnitureType || ctx.seatCount) {
        summary += "Customer wants: ";
        const parts = [];
        if (ctx.material) parts.push(ctx.material);
        if (ctx.furnitureType) parts.push(ctx.furnitureType);
        if (ctx.seatCount) parts.push(`${ctx.seatCount}+ seats`);
        summary += parts.join(', ') + "\n";
    }
    
    // Products shown
    if (commercial.productsShown.length > 0) {
        summary += `Products shown: ${commercial.productsShown.slice(-5).join(', ')}\n`;
    }
    
    // Commercial state
    if (commercial.sentiment !== 'neutral') {
        summary += `Customer sentiment: ${commercial.sentiment}\n`;
    }
    if (commercial.bundlesOffered > 0) {
        summary += `Bundles offered: ${commercial.bundlesOffered}/3\n`;
    }
    
    return summary;
}

function detectCustomerSentiment(message) {
    const msgLower = message.toLowerCase();
    
    // Price concern signals
    const priceConcernWords = ['expensive', 'cost', 'budget', 'afford', 'cheaper', 'price too', 'too much', 'pricey', 'can\'t afford'];
    const isPriceConcerned = priceConcernWords.some(word => msgLower.includes(word));
    
    // Positive signals - customer likes what they see
    const positiveWords = ['love', 'great', 'perfect', 'excellent', 'interested', 'like', 'looks great', 'beautiful', 'amazing', 'fantastic', 'brilliant', 'lovely', 'really like', 'i like'];
    const isPositive = positiveWords.some(word => msgLower.includes(word));
    
    // Strong positive - customer has chosen
    const strongPositiveWords = ['i\'ll take', 'i will take', 'that\'s the one', 'decided', 'go with', 'choose', 'chosen', 'want this', 'want that', 'this one please', 'perfect for me'];
    const isStrongPositive = strongPositiveWords.some(word => msgLower.includes(word));
    
    // Decline signals
    const declineWords = ['no thanks', 'not interested', 'no thank you', 'just the', 'only want', 'don\'t need', 'pass on', 'not for me', 'don\'t like'];
    const isDecline = declineWords.some(word => msgLower.includes(word));
    
    // Bundle interest signals
    const bundleInterestWords = ['bundle', 'discount', 'together', 'package', 'deal', 'cover', 'protect', 'save'];
    const bundleInterest = bundleInterestWords.some(word => msgLower.includes(word));
    
    // ============================================
    // PURCHASE INTENT DETECTION - CRITICAL FOR CLOSING
    // ============================================
    
    // Ready to buy signals - customer wants to purchase NOW
    const readyToBuyWords = [
        'how do i order', 'how do i buy', 'how to order', 'how to buy',
        'where do i buy', 'where can i buy', 'where to buy',
        'add to cart', 'add to basket', 'checkout', 'check out',
        'purchase', 'buy now', 'buy it', 'buy this', 'take it',
        'i\'ll have', 'i will have', 'order this', 'order it',
        'ready to order', 'ready to buy', 'want to order', 'want to buy',
        'place an order', 'make an order', 'complete my order',
        'get the discount', 'apply the discount', 'use the discount',
        'proceed', 'go ahead', 'let\'s do it', 'sounds good let\'s go'
    ];
    const isReadyToBuy = readyToBuyWords.some(word => msgLower.includes(word));
    
    // Confirmation signals - customer saying yes to offers
    const confirmationWords = ['yes', 'yeah', 'yep', 'sure', 'ok', 'okay', 'please', 'go ahead', 'sounds good', 'that\'s great', 'that works', 'absolutely'];
    const isConfirmation = confirmationWords.some(word => {
        // Check if it's a standalone confirmation or at the start
        const regex = new RegExp(`(^|\\s)${word}($|\\s|,|\\.|!)`, 'i');
        return regex.test(msgLower);
    });
    
    // Questions about buying process
    const buyProcessWords = ['delivery', 'shipping', 'payment', 'pay', 'card', 'checkout', 'when will it arrive', 'how long', 'return policy', 'warranty'];
    const isAskingAboutBuying = buyProcessWords.some(word => msgLower.includes(word));
    
    // Calculate purchase intent level (0-3)
    let purchaseIntentLevel = 0;
    if (isAskingAboutBuying) purchaseIntentLevel = 1;
    if (isStrongPositive || isConfirmation) purchaseIntentLevel = 2;
    if (isReadyToBuy) purchaseIntentLevel = 3;
    
    return {
        priceConcerned: isPriceConcerned,
        positive: isPositive || isStrongPositive,
        strongPositive: isStrongPositive,
        decline: isDecline,
        bundleInterest: bundleInterest,
        readyToBuy: isReadyToBuy,
        confirmation: isConfirmation,
        askingAboutBuying: isAskingAboutBuying,
        purchaseIntentLevel: purchaseIntentLevel
    };
}

function checkBundleEligibility(session) {
    const rules = COMMERCE_RULES.bundle;
    const commercial = session.commercial;
    
    // Rule 1: Max offers per session
    if (commercial.bundlesOffered >= rules.maxOffersPerSession) {
        return { eligible: false, reason: 'max_offers_reached' };
    }
    
    // Rule 2: Stop after decline
    if (rules.stopAfterDecline && commercial.bundleDeclined) {
        return { eligible: false, reason: 'customer_declined' };
    }
    
    // Rule 3: Must have shown a product first
    if (commercial.productsShown.length === 0) {
        return { eligible: false, reason: 'no_products_shown' };
    }
    
    return { 
        eligible: true,
        offerType: commercial.bundleInterestShown ? 'detailed' : 'soft'
    };
}

function checkUpsellEligibility(session, targetPrice, currentPrice) {
    const rules = COMMERCE_RULES.upsell;
    const commercial = session.commercial;
    
    // Rule 1: Not first message
    if (session.messageCount <= 2) {
        return { eligible: false, reason: 'too_early' };
    }
    
    // Rule 2: Positive signal required
    if (rules.requirePositiveSignal && !commercial.positiveSignalReceived) {
        return { eligible: false, reason: 'no_positive_signal' };
    }
    
    // Rule 3: Max per session
    if (commercial.upsellsOffered >= rules.maxPerSession) {
        return { eligible: false, reason: 'max_reached' };
    }
    
    // Rule 4: Customer not price-concerned
    if (rules.stopIfPriceConcerned && commercial.sentiment === 'price_concerned') {
        return { eligible: false, reason: 'price_sensitive' };
    }
    
    // Rule 5: Price increase limit
    if (currentPrice && targetPrice) {
        const increase = (targetPrice - currentPrice) / currentPrice;
        if (increase > rules.maxPriceIncrease) {
            return { eligible: false, reason: 'price_jump_too_high' };
        }
    }
    
    // Rule 6: Stop after decline
    if (rules.stopAfterDecline && commercial.upsellDeclined) {
        return { eligible: false, reason: 'customer_declined' };
    }
    
    return { eligible: true };
}

function getBundleForProduct(sku) {
    // Find bundles that include this product
    const matchingBundles = [];
    
    for (const item of bundleItems) {
        if (item.product_sku === sku) {
            const bundle = bundleSuggestions.find(b => b.bundle_id === item.bundle_id);
            if (bundle) {
                const bundleProducts = bundleItems.filter(bi => bi.bundle_id === item.bundle_id);
                matchingBundles.push({
                    ...bundle,
                    products: bundleProducts
                });
            }
        }
    }
    
    return matchingBundles;
}

function getCrossSellSuggestions(sku, session) {
    const product = productIndex.bySku[sku];
    if (!product) return [];
    
    const suggestions = [];
    const alreadyShown = session.commercial.crossSellsShown || [];
    
    // Priority 1: Matching cover
    if (product.related_products?.matching_cover_sku) {
        const coverSku = product.related_products.matching_cover_sku;
        if (!alreadyShown.includes(coverSku) && isInStock(coverSku)) {
            suggestions.push({
                type: 'cover',
                sku: coverSku,
                priority: 1,
                pitch: "Protect your investment with a matching cover - extends lifespan by 3-5 years!"
            });
        }
    }
    
    // Priority 2: Cushion box (check product name/category)
    const materialType = product.description_and_category?.material_type?.toLowerCase();
    if (materialType === 'rattan') {
        // Find matching cushion box
        const cushionBoxSku = `${product.product_identity?.product_family || 'GENERAL'}-CUSHION-BOX`;
        if (productIndex.bySku[cushionBoxSku] && isInStock(cushionBoxSku)) {
            suggestions.push({
                type: 'cushion_box',
                sku: cushionBoxSku,
                priority: 2,
                pitch: "Keep your cushions fresh and dry with a matching cushion storage box!"
            });
        }
    }
    
    // Priority 4: Assembly service
    if (product.specifications?.assembly?.required) {
        suggestions.push({
            type: 'assembly',
            sku: 'ASSEMBLY-SERVICE',
            priority: 4,
            price: COMMERCE_RULES.crossSell.assemblyPrice,
            pitch: `Save time with our professional assembly service - just £${COMMERCE_RULES.crossSell.assemblyPrice}!`
        });
    }
    
    // Sort by priority
    return suggestions.sort((a, b) => a.priority - b.priority);
}

// ============================================
// CLOSING FLOW - CONVERT READY BUYERS
// ============================================

function buildClosingResponse(session, sentiment) {
    const lastProducts = session.commercial.productsShown.slice(-3);
    const mainProductSku = lastProducts[0];
    const mainProduct = mainProductSku ? productIndex.bySku[mainProductSku] : null;
    
    if (!mainProduct) {
        return {
            type: 'soft_close',
            text: "I'd love to help you complete your purchase! Which product caught your eye? I can guide you through the ordering process."
        };
    }
    
    const productName = mainProduct.product_identity?.product_name || 'your selected product';
    const productUrl = `https://www.mint-outdoor.com/products/${mainProductSku.toLowerCase()}`;
    const price = parseFloat(mainProduct.product_identity?.price_gbp) || 0;
    
    // Check if there's a bundle available
    const bundles = getBundleForProduct(mainProductSku);
    const hasBundle = bundles.length > 0;
    
    if (hasBundle && session.commercial.bundleInterestShown) {
        // Customer showed interest in bundle - give bundle checkout flow
        const bundle = bundles[0];
        let bundleTotal = 0;
        const bundleProductNames = [];
        
        for (const item of bundle.products) {
            const prod = productIndex.bySku[item.product_sku];
            if (prod) {
                const itemPrice = parseFloat(prod.product_identity?.price_gbp) || 0;
                bundleTotal += itemPrice * item.product_qty;
                bundleProductNames.push(prod.product_identity?.product_name);
            }
        }
        
        const discount = bundleTotal * (COMMERCE_RULES.bundle.discountPercent / 100);
        const finalPrice = bundleTotal - discount;
        
        return {
            type: 'bundle_checkout',
            intent: 'checkout_flow',
            text: `Brilliant choice! Here's how to get your bundle with the ${COMMERCE_RULES.bundle.discountPercent}% discount:\n\n` +
                  `**Your Bundle:**\n` +
                  bundleProductNames.map(n => `✓ ${n}`).join('\n') + `\n\n` +
                  `**Bundle Price: £${finalPrice.toFixed(2)}** ~~£${bundleTotal.toFixed(2)}~~\n` +
                  `*You save: £${discount.toFixed(2)}*\n\n` +
                  `**To order:**\n` +
                  `1️⃣ Click the link below to view the main product\n` +
                  `2️⃣ Add it to your basket\n` +
                  `3️⃣ The matching accessories will be suggested at checkout\n` +
                  `4️⃣ Your ${COMMERCE_RULES.bundle.discountPercent}% bundle discount applies automatically!\n\n` +
                  `<a href="${productUrl}" target="_blank" style="display:inline-block; padding:12px 24px; background:#2E6041; color:white; text-decoration:none; border-radius:5px; font-weight:bold;">ORDER NOW → £${finalPrice.toFixed(2)}</a>\n\n` +
                  `Or if you'd like me to email you this quote to review later, just let me know your email address and I'll send it with the discount locked in for 48 hours! 📧`,
            mainProduct: mainProductSku,
            bundlePrice: finalPrice,
            savingsAmount: discount
        };
    } else {
        // Standard product checkout flow
        return {
            type: 'product_checkout',
            intent: 'checkout_flow',
            text: `Excellent choice! The **${productName}** is one of our most popular sets.\n\n` +
                  `**Price: £${price.toFixed(2)}**\n` +
                  `✅ In stock with 3-5 day delivery\n` +
                  `✅ 1-year warranty included\n\n` +
                  `**To order:**\n` +
                  `Simply click the button below to add it to your basket and checkout:\n\n` +
                  `<a href="${productUrl}" target="_blank" style="display:inline-block; padding:12px 24px; background:#2E6041; color:white; text-decoration:none; border-radius:5px; font-weight:bold;">ORDER NOW → £${price.toFixed(2)}</a>\n\n` +
                  `Would you also like a protective cover? It extends the furniture's life by 3-5 years and you'll save ${COMMERCE_RULES.bundle.discountPercent}% when bought together! 🎁`,
            mainProduct: mainProductSku,
            productPrice: price
        };
    }
}

function buildEmailCaptureResponse(session) {
    const lastProducts = session.commercial.productsShown.slice(-3);
    const mainProductSku = lastProducts[0];
    const mainProduct = mainProductSku ? productIndex.bySku[mainProductSku] : null;
    
    const productName = mainProduct?.product_identity?.product_name || 'your selected items';
    
    return {
        type: 'email_capture',
        intent: 'email_capture',
        text: `I'd be happy to email you a summary of ${productName} with all the details and your exclusive discount.\n\n` +
              `Just share your email address and I'll send:\n` +
              `📋 Product specifications and dimensions\n` +
              `💰 Your personalised quote with any bundle discounts\n` +
              `🔒 Discount locked in for 48 hours\n\n` +
              `What's the best email to send this to?`
    };
}

function getContextAwareClosingCopy(session, sentiment) {
    const commercial = session.commercial;
    
    // Customer has shown strong positive signals - don't ask if they like it!
    if (sentiment.strongPositive || commercial.positiveSignalReceived) {
        const options = [
            "Ready to order? Click the 'View Product' button above, or let me know if you have any final questions!",
            "Great choice! Click above to add it to your basket, or ask me anything else you'd like to know.",
            "Shall I help you complete your purchase? Just click the product link above to checkout.",
            "Click the button above to order, or let me know if you'd like more details on delivery and warranty."
        ];
        return options[Math.floor(Math.random() * options.length)];
    }
    
    // Customer asked about buying process - they're close to converting
    if (sentiment.askingAboutBuying) {
        return "Does this answer your question? When you're ready, just click the product link above to complete your order.";
    }
    
    // Customer is in discovery mode - standard closing
    if (commercial.productsShown.length <= 3) {
        return "Which of these catches your eye? I can tell you more about any of them.";
    }
    
    // Customer has seen multiple products - help them decide
    if (commercial.productsShown.length > 5) {
        return "You've seen a few options now! Would you like me to help you compare, or is there one that stands out?";
    }
    
    // Default
    return "Would any of these work for your space? Let me know if you'd like more details.";
}

function buildBundleOffer(session, mainProductSku, offerType) {
    const bundles = getBundleForProduct(mainProductSku);
    if (bundles.length === 0) return null;
    
    const bundle = bundles[0]; // Take first matching bundle
    const mainProduct = productIndex.bySku[mainProductSku];
    
    if (offerType === 'soft') {
        return {
            type: 'soft',
            text: `🎁 *Great news! This comes with a matching protective cover bundle - save ${COMMERCE_RULES.bundle.discountPercent}% when you buy together. Would you like details?*`
        };
    } else {
        // Detailed pricing
        let totalOriginal = 0;
        let productDetails = [];
        
        for (const item of bundle.products) {
            const prod = productIndex.bySku[item.product_sku];
            if (prod) {
                const price = parseFloat(prod.product_identity?.price_gbp) || 0;
                totalOriginal += price * item.product_qty;
                productDetails.push(`- ${prod.product_identity?.product_name}: £${price.toFixed(2)}`);
            }
        }
        
        const discount = totalOriginal * (COMMERCE_RULES.bundle.discountPercent / 100);
        const bundlePrice = totalOriginal - discount;
        
        return {
            type: 'detailed',
            text: `🎁 **${bundle.name} Bundle Deal**\n\n${productDetails.join('\n')}\n\n~~Original: £${totalOriginal.toFixed(2)}~~\n**Bundle Price: £${bundlePrice.toFixed(2)}**\n*You save: £${discount.toFixed(2)} (${COMMERCE_RULES.bundle.discountPercent}% off)*\n\nWant me to add this bundle to help you complete your purchase?`
        };
    }
}

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

async function assembleResponse(aiOutput, sessionId, session) {
    const intent = aiOutput.intent;
    
    // ============================================
    // HANDLE CHECKOUT FLOW RESPONSES
    // ============================================
    if (intent === 'checkout_flow') {
        return aiOutput.response_text || aiOutput.text || "Let me help you complete your purchase!";
    }
    
    if (intent === 'email_capture') {
        return aiOutput.response_text || aiOutput.text || "I'd be happy to email you the details!";
    }
    
    // For non-product intents, use AI's response text directly
    if (intent !== 'product_recommendation') {
        return aiOutput.response_text || "I'm here to help! What would you like to know about our outdoor furniture?";
    }
    
    // For product recommendations, render cards server-side
    const parts = [];
    
    if (aiOutput.intro_copy) {
        parts.push(aiOutput.intro_copy);
    }
    
    let mainProductSku = null;
    
    if (aiOutput.selected_skus && aiOutput.selected_skus.length > 0) {
        mainProductSku = aiOutput.selected_skus[0];
        
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
    
    // ============================================
    // INTELLIGENT CROSS-SELL TIMING
    // Only cross-sell AFTER positive signals, not on first showing
    // ============================================
    
    if (mainProductSku && session) {
        const hasPositiveSignal = session.commercial.positiveSignalReceived;
        const messageCount = session.messageCount;
        const productsAlreadyShown = session.commercial.productsShown.length;
        
        // Check if we should offer a bundle
        const bundleEligibility = checkBundleEligibility(session);
        
        // Only show bundle offers if:
        // 1. Eligible AND
        // 2. (Customer showed positive signal OR this is at least their 3rd message OR they've seen products before)
        const shouldOfferBundle = bundleEligibility.eligible && 
            (hasPositiveSignal || messageCount >= 3 || productsAlreadyShown > 0);
        
        if (shouldOfferBundle) {
            const bundleOffer = buildBundleOffer(session, mainProductSku, bundleEligibility.offerType);
            
            if (bundleOffer) {
                parts.push('');
                parts.push(bundleOffer.text);
                session.commercial.bundlesOffered++;
                session.commercial.lastOfferType = 'bundle';
                console.log(`🎁 Bundle offer added (${bundleEligibility.offerType}) - positive signal: ${hasPositiveSignal}`);
            }
        }
        
        // Cross-sell: Only if no bundle offered AND customer has shown interest
        if (!shouldOfferBundle && hasPositiveSignal) {
            const crossSells = getCrossSellSuggestions(mainProductSku, session);
            
            if (crossSells.length > 0 && session.commercial.crossSellsShown.length < 2) {
                const suggestion = crossSells[0];
                parts.push('');
                parts.push(`💡 *${suggestion.pitch}*`);
                session.commercial.crossSellsShown.push(suggestion.sku);
                console.log(`💡 Cross-sell suggested: ${suggestion.type}`);
            }
        }
    }
    
    // ============================================
    // CONTEXT-AWARE CLOSING COPY
    // Don't ask "would you like these?" if customer already said yes!
    // ============================================
    
    // Get the latest sentiment to determine closing copy
    const latestSentiment = session.commercial.latestSentiment || { positive: false };
    
    const closingCopy = getContextAwareClosingCopy(session, latestSentiment);
    parts.push('');
    parts.push(closingCopy);
    
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
                    upsellsOffered: 0,
                    upsellDeclined: false,
                    bundleInterestShown: false,
                    positiveSignalReceived: false,
                    strongPositiveReceived: false,
                    sentiment: 'neutral',
                    latestSentiment: null,
                    productsShown: [],
                    crossSellsShown: [],
                    lastProductPrice: null,
                    lastOfferType: null
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

        // ============================================
        // DETECT CUSTOMER SENTIMENT AND PURCHASE INTENT
        // ============================================
        const sentiment = detectCustomerSentiment(message);
        
        // Store latest sentiment for closing copy decisions
        session.commercial.latestSentiment = sentiment;
        
        if (sentiment.priceConcerned) {
            session.commercial.sentiment = 'price_concerned';
            console.log(`💰 Sentiment: Price concerned`);
        } else if (sentiment.positive) {
            session.commercial.sentiment = 'positive';
            session.commercial.positiveSignalReceived = true;
            console.log(`😊 Sentiment: Positive signal received`);
        }
        
        if (sentiment.strongPositive) {
            session.commercial.strongPositiveReceived = true;
            console.log(`🎯 Sentiment: Strong positive - customer has chosen!`);
        }
        
        if (sentiment.bundleInterest) {
            session.commercial.bundleInterestShown = true;
            console.log(`🎁 Bundle interest detected`);
        }
        
        if (sentiment.decline) {
            if (session.commercial.lastOfferType === 'bundle') {
                session.commercial.bundleDeclined = true;
                console.log(`❌ Bundle offer declined`);
            } else if (session.commercial.lastOfferType === 'upsell') {
                session.commercial.upsellDeclined = true;
                console.log(`❌ Upsell declined`);
            }
        }
        
        // ============================================
        // PURCHASE INTENT HANDLING - TRIGGER CLOSING FLOW
        // ============================================
        if (sentiment.readyToBuy && session.commercial.productsShown.length > 0) {
            console.log(`🛒 PURCHASE INTENT DETECTED - Triggering closing flow`);
            
            // Build closing response directly - don't let AI show more products
            const closingResponse = buildClosingResponse(session, sentiment);
            
            // Add to conversation history
            session.conversationHistory.push({
                role: 'user',
                content: message,
                timestamp: new Date().toISOString()
            });
            session.conversationHistory.push({
                role: 'assistant',
                content: closingResponse.text,
                metadata: {
                    intent: 'checkout_flow',
                    timestamp: new Date().toISOString()
                }
            });
            
            console.log(`📤 Closing flow response sent`);
            
            return res.json({
                response: closingResponse.text,
                sessionId: sessionId
            });
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

            if (toolCall.function.name === "capture_email_for_quote") {
                    console.log(`📧 Email capture:`, args);
                    
                    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                    if (!emailRegex.test(args.email)) {
                        toolResults.push({
                            tool_call_id: toolCall.id,
                            output: JSON.stringify({
                                success: false,
                                message: "That doesn't look like a valid email. Please ask for a valid email address."
                            })
                        });
                    } else {
                        // Store email in session
                        session.customerEmail = args.email;
                        
                        // Get products for quote
                        const productsForQuote = args.productSkus || session.commercial.productsShown.slice(-3);
                        
                        // In production, you would send an actual email here
                        // For now, we log it and confirm
                        console.log(`📧 Quote requested for: ${args.email}`);
                        console.log(`📧 Products: ${productsForQuote.join(', ')}`);
                        
                        toolResults.push({
                            tool_call_id: toolCall.id,
                            output: JSON.stringify({
                                success: true,
                                email: args.email,
                                products: productsForQuote,
                                message: `Email captured successfully. Confirm to customer that quote will be sent to ${args.email} within a few minutes, with their discount locked in for 48 hours. Also mention they can reply to the email if they have questions.`
                            })
                        });
                    }
                }
                
                if (toolCall.function.name === "initiate_checkout") {
                    console.log(`🛒 Checkout initiated:`, args);
                    
                    const product = productIndex.bySku[args.productSku];
                    if (!product) {
                        toolResults.push({
                            tool_call_id: toolCall.id,
                            output: JSON.stringify({
                                success: false,
                                message: "Product not found. Ask customer which product they'd like to order."
                            })
                        });
                    } else {
                        const productUrl = `https://www.mint-outdoor.com/products/${args.productSku.toLowerCase()}`;
                        const price = parseFloat(product.product_identity?.price_gbp) || 0;
                        
                        let checkoutInfo = {
                            success: true,
                            productName: product.product_identity?.product_name,
                            productUrl: productUrl,
                            price: price,
                            message: `Direct the customer to click the ORDER NOW button or visit: ${productUrl}`
                        };
                        
                        // Add bundle info if requested
                        if (args.includeBundle) {
                            const bundles = getBundleForProduct(args.productSku);
                            if (bundles.length > 0) {
                                const bundle = bundles[0];
                                let bundleTotal = 0;
                                for (const item of bundle.products) {
                                    const prod = productIndex.bySku[item.product_sku];
                                    if (prod) {
                                        bundleTotal += (parseFloat(prod.product_identity?.price_gbp) || 0) * item.product_qty;
                                    }
                                }
                                const discount = bundleTotal * 0.20;
                                checkoutInfo.bundlePrice = bundleTotal - discount;
                                checkoutInfo.bundleSavings = discount;
                                checkoutInfo.message += ` Bundle discount of 20% (saving £${discount.toFixed(2)}) applies at checkout when they add the matching cover.`;
                            }
                        }
                        
                        toolResults.push({
                            tool_call_id: toolCall.id,
                            output: JSON.stringify(checkoutInfo)
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
        
// ============================================
        // ROBUST JSON PARSING WITH CONTEXT PRESERVATION
        // ============================================
        
        let aiOutput;
        
        // LAYER 1: Try direct JSON parse
        try {
            aiOutput = JSON.parse(aiMessage.content);
            console.log(`✅ AI intent: ${aiOutput.intent}`);
        } catch (parseError) {
            console.log(`⚠️ JSON parse failed, trying extraction...`);
            
            // LAYER 2: Try to extract JSON from markdown code blocks
            const jsonMatch = aiMessage.content?.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (jsonMatch) {
                try {
                    aiOutput = JSON.parse(jsonMatch[1].trim());
                    console.log(`✅ Extracted JSON from code block`);
                } catch (e2) {
                    console.log(`⚠️ Code block extraction failed`);
                }
            }
            
            // LAYER 3: Try to find JSON object in response
            if (!aiOutput) {
                const objectMatch = aiMessage.content?.match(/\{[\s\S]*\}/);
                if (objectMatch) {
                    try {
                        aiOutput = JSON.parse(objectMatch[0]);
                        console.log(`✅ Extracted JSON object from response`);
                    } catch (e3) {
                        console.log(`⚠️ Object extraction failed`);
                    }
                }
            }
            
            // LAYER 4: CONTEXT-AWARE INTELLIGENT FALLBACK
            if (!aiOutput) {
                console.log(`🔄 Using context-aware fallback`);
                const ctx = session.context;
                const hasWhitelist = session.currentWhitelist && session.currentWhitelist.length > 0;
                const hasContext = ctx.material || ctx.furnitureType || ctx.seatCount;
                
                if (hasWhitelist && hasContext) {
                    // We have products to show - show them!
                    let introText = "Here are some great options";
                    const contextParts = [];
                    if (ctx.material) contextParts.push(ctx.material);
                    if (ctx.furnitureType) contextParts.push(ctx.furnitureType);
                    if (ctx.seatCount) contextParts.push(`seating ${ctx.seatCount}+ people`);
                    
                    if (contextParts.length > 0) {
                        introText = `Based on what you've told me about wanting ${contextParts.join(' ')} furniture, here are some perfect matches:`;
                    }
                    
                    aiOutput = {
                        intent: 'product_recommendation',
                        intro_copy: introText,
                        selected_skus: session.currentWhitelist.slice(0, 3),
                        personalisation: `Perfect for your ${ctx.furnitureType || 'outdoor'} space`,
                        closing_copy: "Would any of these work for you? I can also tell you more about materials, warranties, or dimensions."
                    };
                    console.log(`✅ Fallback: Showing ${session.currentWhitelist.length} products with context`);
                    
                } else if (hasContext && !hasWhitelist) {
                    // We have context but no products searched yet
                    const contextParts = [];
                    if (ctx.material) contextParts.push(ctx.material);
                    if (ctx.furnitureType) contextParts.push(ctx.furnitureType);
                    if (ctx.seatCount) contextParts.push(`for ${ctx.seatCount} people`);
                    
                    aiOutput = {
                        intent: 'clarification',
                        response_text: `Great! I can see you're interested in ${contextParts.join(' ')} furniture. Let me find the best options for you. Just to make sure I show you exactly what you need - are you looking for something for dining or lounging?`
                    };
                    console.log(`✅ Fallback: Acknowledging context, asking to refine`);
                    
                } else {
                    // No context at all
                    aiOutput = {
                        intent: 'greeting',
                        response_text: "Hi there! I'm Gwen, your outdoor furniture expert. What kind of outdoor space are you looking to furnish - a dining area, a cosy lounge spot, or perhaps both?"
                    };
                    console.log(`✅ Fallback: Fresh greeting`);
                }
            }
        }
        
        // ============================================
        // VALIDATION WITH CONTEXT PRESERVATION
        // ============================================
        
        aiOutput = validateAIOutput(aiOutput, session.currentWhitelist, sessionId);
        
        if (!aiOutput) {
            const ctx = session.context;
            let fallbackText = "I'd love to help you find the perfect outdoor furniture.";
            
            if (ctx.material || ctx.seatCount) {
                fallbackText = `I'm still looking for ${ctx.material || 'furniture'}${ctx.seatCount ? ' for ' + ctx.seatCount + ' people' : ''}. Could you tell me if you prefer dining or lounge style?`;
            }
            
            aiOutput = {
                intent: 'clarification',
                response_text: fallbackText
            };
        }

        // Assemble response
        const finalResponse = await assembleResponse(aiOutput, sessionId, session);

        
        // ============================================
        // ENHANCED CONVERSATION HISTORY MANAGEMENT
        // ============================================
        
        // Build a rich context entry that includes what happened
        const userEntry = {
            role: 'user',
            content: message,
            timestamp: new Date().toISOString()
        };
        
        const assistantEntry = {
            role: 'assistant',
            content: finalResponse,
            metadata: {
                intent: aiOutput.intent,
                productsShown: aiOutput.selected_skus || [],
                timestamp: new Date().toISOString()
            }
        };
        
        session.conversationHistory.push(userEntry);
        session.conversationHistory.push(assistantEntry);
        
        // Track products shown in commercial state
        if (aiOutput.intent === 'product_recommendation' && aiOutput.selected_skus) {
            for (const sku of aiOutput.selected_skus) {
                if (!session.commercial.productsShown.includes(sku)) {
                    session.commercial.productsShown.push(sku);
                }
                // Track last product price for upsell calculations
                const product = productIndex.bySku[sku];
                if (product?.product_identity?.price_gbp) {
                    session.commercial.lastProductPrice = parseFloat(product.product_identity.price_gbp);
                }
            }
        }
        
        // Keep history manageable but preserve more context (last 12 messages = 6 exchanges)
        if (session.conversationHistory.length > 12) {
            // Keep first 2 messages (initial context) and last 10
            const firstMessages = session.conversationHistory.slice(0, 2);
            const recentMessages = session.conversationHistory.slice(-10);
            session.conversationHistory = [...firstMessages, ...recentMessages];
        }
        
        // Create a state summary for the AI to reference
        session.stateSummary = buildStateSummary(session);
        
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
