// GWEN SALES AGENT - PHASE 1 IMPLEMENTATION
// Version: 13.1 - SERVER-SIDE RENDERING (CORRECT IMPLEMENTATION)
// Following approved specification v3.0/v4.0 exactly
//
// ARCHITECTURE:
// Customer Message → AI outputs JSON (SKUs only) → Server validates → Server renders → Customer
//
// THE AI NEVER WRITES PRODUCT NAMES, PRICES, OR FEATURES
// THE SERVER RENDERS ALL PRODUCT INFORMATION FROM VERIFIED DATA

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
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getCachedShopifyData(sku) {
    const cached = SHOPIFY_CACHE.get(sku);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
        console.log(`📦 Cache HIT for ${sku}`);
        return cached.data;
    }
    
    if (!SHOPIFY_ACCESS_TOKEN) {
        console.log(`⚠️ No Shopify token - using local data for ${sku}`);
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
        
        if (!response.ok) {
            console.log(`⚠️ Shopify returned ${response.status} for ${sku}`);
            return null;
        }
        
        const data = await response.json();
        const product = data.products?.[0];
        
        if (!product) {
            console.log(`⚠️ No Shopify product found for ${sku}`);
            return null;
        }
        
        const result = {
            price: parseFloat(product.variants[0]?.price) || 0,
            stock: product.variants[0]?.inventory_quantity || 0,
            url: `https://www.mint-outdoor.com/products/${product.handle}`,
            available: product.variants[0]?.inventory_quantity > 0,
            title: product.title
        };
        
        SHOPIFY_CACHE.set(sku, { data: result, timestamp: Date.now() });
        console.log(`📦 Cache MISS - fetched ${sku}: £${result.price}, stock: ${result.stock}`);
        
        return result;
        
    } catch (error) {
        console.error(`❌ Shopify fetch error for ${sku}:`, error.message);
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
const inventoryData = loadDataFile('Inventory_Data.json', []);
const bundleSuggestions = loadDataFile('bundle_suggestions.json', []);
const bundleItems = loadDataFile('bundle_items.json', []);

// Build product index
const productIndex = { bySku: {} };
productKnowledgeCenter.forEach(product => {
    const sku = product.product_identity?.sku;
    if (sku) {
        productIndex.bySku[sku] = product;
    }
});

console.log(`📦 Indexed ${Object.keys(productIndex.bySku).length} products`);

// ============================================
// AI OUTPUT SCHEMA (JSON ONLY - NO PROSE)
// ============================================

const AI_JSON_SCHEMA = {
    type: "object",
    properties: {
        intent: {
            type: "string",
            enum: ["greeting", "clarification", "product_recommendation", "question_answer", "handoff", "farewell"],
            description: "Type of response"
        },
        intro_copy: {
            type: "string",
            description: "Opening conversational line (max 150 chars)"
        },
        selected_skus: {
            type: "array",
            items: { type: "string" },
            description: "Array of product SKU codes to display - ONLY from search results"
        },
        personalisation: {
            type: ["string", "null"],
            description: "Personal hook like 'Perfect for summer BBQs'"
        },
        commercial_signals: {
            type: "object",
            properties: {
                customer_sentiment: {
                    type: "string",
                    enum: ["positive", "neutral", "negative", "price_concerned"]
                },
                bundle_candidate: { type: "boolean" }
            },
            required: ["customer_sentiment", "bundle_candidate"]
        },
        closing_question: {
            type: "string",
            description: "Question to continue conversation"
        },
        clarification_question: {
            type: ["string", "null"],
            description: "For clarification intent - what to ask customer"
        },
        answer_text: {
            type: ["string", "null"],
            description: "For question_answer intent - the answer"
        }
    },
    required: ["intent", "intro_copy", "commercial_signals", "closing_question"],
    additionalProperties: false
};

// ============================================
// AI SYSTEM PROMPT (JSON OUTPUT ONLY)
// ============================================

function buildSystemPrompt(sessionState, availableSkus) {
    return `You are Gwen, a friendly sales assistant for MINT Outdoor furniture.

CRITICAL: You output JSON only. You NEVER write product names, prices, or descriptions.

YOUR ROLE:
1. Understand what the customer wants
2. Select products by SKU code ONLY from the available list
3. Write friendly conversational copy
4. Signal if customer might want bundles

AVAILABLE PRODUCT SKUs (you can ONLY select from these):
${availableSkus.length > 0 ? availableSkus.join(', ') : 'No products searched yet - ask what they need'}

OUTPUT FORMAT - Return ONLY valid JSON:
{
    "intent": "product_recommendation",
    "intro_copy": "Here are some great options for you:",
    "selected_skus": ["SKU-1", "SKU-2"],
    "personalisation": "Perfect for summer entertaining",
    "commercial_signals": {
        "customer_sentiment": "positive",
        "bundle_candidate": true
    },
    "closing_question": "Which catches your eye?"
}

INTENT TYPES:
- "greeting": Customer just said hello - ask what they're looking for
- "clarification": Need more info - set clarification_question
- "product_recommendation": Showing products - set selected_skus
- "question_answer": Answering warranty/delivery/material questions - set answer_text
- "handoff": Customer needs human help
- "farewell": Goodbye

RULES:
1. NEVER write product names - only use SKU codes in selected_skus
2. NEVER write prices - server handles this
3. NEVER write features - server handles this
4. ONLY select SKUs from the AVAILABLE list above
5. If no products available, use "clarification" intent and ask what they need
6. Keep intro_copy warm and conversational (max 150 chars)

SESSION STATE:
${JSON.stringify(sessionState, null, 2)}`;
}

// ============================================
// SKU VALIDATION (PREVENTS HALLUCINATION)
// ============================================

function validateSkusAgainstWhitelist(selectedSkus, whitelist, sessionId) {
    const approved = [];
    const rejected = [];
    
    for (const sku of (selectedSkus || [])) {
        if (whitelist.includes(sku)) {
            approved.push(sku);
        } else {
            rejected.push(sku);
            console.log(`🛡️ [${sessionId}] HALLUCINATION BLOCKED: "${sku}" not in whitelist`);
        }
    }
    
    if (rejected.length > 0) {
        console.log(`🛡️ Whitelist: [${whitelist.join(', ')}]`);
        console.log(`🛡️ Rejected: [${rejected.join(', ')}]`);
    }
    
    return { approved, rejected };
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
    
    // Get local inventory data as fallback
    const localInventory = inventoryData.find(i => i.sku === sku);
    
    // Determine price
    const price = shopifyData?.price || 
                  parseFloat(productData.product_identity?.price_gbp) || 0;
    
    // Determine stock
    const stock = shopifyData?.stock ?? 
                  parseInt(localInventory?.available) ?? 
                  parseInt(productData.logistics_and_inventory?.inventory?.available) ?? 0;
    
    // CRITICAL: Filter out of stock products
    if (stock <= 0) {
        console.log(`📦 FILTERING OUT ${sku} - out of stock`);
        return null;
    }
    
    const name = productData.product_identity?.product_name || 'Product';
    const imageUrl = productData.product_identity?.image_url || '';
    const productUrl = shopifyData?.url || `https://www.mint-outdoor.com/search?q=${sku}`;
    
    // Extract REAL features from materials (no hallucination possible)
    const features = [];
    if (productData.materials_and_care) {
        productData.materials_and_care.forEach(mat => {
            if (mat.warranty) {
                features.push(`${mat.name}: ${mat.warranty}`);
            }
            if (mat.durability_rating) {
                features.push(`Durability: ${mat.durability_rating}`);
            }
        });
    }
    
    // Stock message
    let stockMessage = '';
    if (stock <= 5) {
        stockMessage = `🚨 Only ${stock} left - selling fast!`;
    } else if (stock <= 20) {
        stockMessage = `⚠️ Low stock - ${stock} remaining`;
    } else {
        stockMessage = `✅ In stock`;
    }
    
    // Build card
    let card = `**${name}**\n`;
    
    if (imageUrl) {
        card += `<img src="${imageUrl}" alt="${name}" style="max-width:100%; border-radius:8px; margin:8px 0;">\n\n`;
    }
    
    if (personalisation) {
        card += `✨ ${personalisation}\n\n`;
    }
    
    if (features.length > 0) {
        card += `💪 **Why customers love this:**\n`;
        features.slice(0, 3).forEach(f => {
            card += `• ${f}\n`;
        });
        card += '\n';
    }
    
    card += `Price: £${price.toFixed(2)}\n`;
    card += `Stock Status: ${stockMessage}\n`;
    card += `SKU: ${sku}\n\n`;
    card += `[View Product](${productUrl})\n`;
    
    if (showBundleHint && productData.related_products?.matching_cover_sku) {
        card += `\n🎁 *Matching cover available with 20% bundle discount*\n`;
    }
    
    return card;
}

async function renderAllProductCards(skus, sessionId, personalisation = '') {
    const cards = [];
    
    for (let i = 0; i < skus.length; i++) {
        const sku = skus[i];
        const showBundleHint = (i === 0); // Only on first product
        
        const card = await renderProductCard(sku, { 
            showBundleHint, 
            personalisation: i === 0 ? personalisation : '' 
        });
        
        if (card) {
            cards.push(card);
        }
    }
    
    if (cards.length === 0) {
        return null;
    }
    
    return cards.join('\n---\n\n');
}

// ============================================
// RESPONSE ASSEMBLER
// ============================================

async function assembleResponse(aiOutput, sessionId) {
    const parts = [];
    
    // 1. Add intro copy from AI
    if (aiOutput.intro_copy) {
        parts.push(aiOutput.intro_copy);
        parts.push('');
    }
    
    // 2. Render product cards (server-side, not AI)
    if (aiOutput.selected_skus && aiOutput.selected_skus.length > 0) {
        const productCards = await renderAllProductCards(
            aiOutput.selected_skus, 
            sessionId,
            aiOutput.personalisation || ''
        );
        
        if (productCards) {
            parts.push(productCards);
        } else {
            parts.push("I found some options but they're currently out of stock. Let me find alternatives for you.");
        }
    }
    
    // 3. Add clarification question if needed
    if (aiOutput.intent === 'clarification' && aiOutput.clarification_question) {
        parts.push(aiOutput.clarification_question);
    }
    
    // 4. Add answer text if needed
    if (aiOutput.intent === 'question_answer' && aiOutput.answer_text) {
        parts.push(aiOutput.answer_text);
    }
    
    // 5. Add closing question
    if (aiOutput.closing_question && aiOutput.intent !== 'clarification') {
        parts.push('');
        parts.push(aiOutput.closing_question);
    }
    
    return parts.join('\n');
}

// ============================================
// PRODUCT SEARCH (Updates Whitelist)
// ============================================

function searchProducts(criteria) {
    const { furnitureType, material, seatCount, productName, maxResults = 5 } = criteria;
    
    let filtered = Object.values(productIndex.bySku).filter(p => 
        p.product_identity?.sku && 
        p.description_and_category?.primary_category
    );
    
    console.log(`🔍 Search: type=${furnitureType}, material=${material}, seats=${seatCount}`);
    
    // Filter by furniture type
    if (furnitureType) {
        const type = furnitureType.toLowerCase();
        filtered = filtered.filter(p => {
            const taxonomy = p.description_and_category?.taxonomy_type?.toLowerCase() || '';
            const category = p.description_and_category?.primary_category?.toLowerCase() || '';
            const name = p.product_identity?.product_name?.toLowerCase() || '';
            
            if (type === 'dining') return taxonomy.includes('dining') || name.includes('dining');
            if (type === 'lounge') return taxonomy.includes('lounge') || name.includes('lounge') || name.includes('sofa');
            if (type === 'corner') return taxonomy.includes('corner') || name.includes('corner');
            return false;
        });
    }
    
    // Filter by material
    if (material) {
        const mat = material.toLowerCase();
        filtered = filtered.filter(p => {
            const materialType = p.description_and_category?.material_type?.toLowerCase() || '';
            return materialType.includes(mat);
        });
    }
    
    // Filter by seat count
    if (seatCount) {
        const target = parseInt(seatCount);
        filtered = filtered.filter(p => {
            const seats = parseInt(p.specifications?.seats);
            return seats && Math.abs(seats - target) <= 2;
        });
    }
    
    // Filter by name
    if (productName) {
        const search = productName.toLowerCase();
        filtered = filtered.filter(p => {
            const name = p.product_identity?.product_name?.toLowerCase() || '';
            return name.includes(search);
        });
    }
    
    const results = filtered.slice(0, maxResults);
    console.log(`🔍 Found ${results.length} products`);
    
    return results.map(p => ({
        sku: p.product_identity.sku,
        name: p.product_identity.product_name,
        category: p.description_and_category?.primary_category
    }));
}

// ============================================
// AI TOOLS
// ============================================

const aiTools = [
    {
        type: "function",
        function: {
            name: "search_products",
            description: "Search for products by criteria. Returns SKU codes only.",
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
                        description: "Material (teak, aluminium, rattan)"
                    },
                    seatCount: {
                        type: "integer",
                        description: "Number of seats"
                    },
                    productName: {
                        type: "string",
                        description: "Product name to search"
                    }
                }
            }
        }
    }
];

// ============================================
// MAIN CHAT ENDPOINT (NEW ARCHITECTURE)
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
        console.log(`📩 [${sessionId}] Message: "${message}"`);
        
        // Get or create session
        if (!sessions.has(sessionId)) {
            sessions.set(sessionId, {
                messageCount: 0,
                currentWhitelist: [],
                context: {},
                commercial: {
                    bundlesOffered: 0,
                    bundleDeclined: false
                }
            });
        }
        
        const session = sessions.get(sessionId);
        session.messageCount++;
        
        // Build session state for AI
        const sessionState = {
            messageCount: session.messageCount,
            requirements: session.context,
            commercial: session.commercial
        };
        
        // Build messages for AI
        const systemPrompt = buildSystemPrompt(sessionState, session.currentWhitelist);
        
        let messages = [
            { role: "system", content: systemPrompt },
            { role: "user", content: message }
        ];
        
        console.log(`🤖 Calling AI with ${session.currentWhitelist.length} SKUs in whitelist`);
        
        // Call AI with tools
        let response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: messages,
            tools: aiTools,
            tool_choice: "auto",
            temperature: 0.3
        });
        
        let aiMessage = response.choices[0].message;
        
        // Handle tool calls (search)
        if (aiMessage.tool_calls) {
            const toolResults = [];
            
            for (const toolCall of aiMessage.tool_calls) {
                if (toolCall.function.name === "search_products") {
                    const args = JSON.parse(toolCall.function.arguments);
                    console.log(`🔍 Search request:`, args);
                    
                    const products = searchProducts(args);
                    
                    // UPDATE WHITELIST - This is critical for preventing hallucination
                    const newSkus = products.map(p => p.sku);
                    session.currentWhitelist = newSkus;
                    console.log(`🛡️ Whitelist updated to: [${newSkus.join(', ')}]`);
                    
                    toolResults.push({
                        tool_call_id: toolCall.id,
                        output: JSON.stringify({
                            success: true,
                            available_skus: newSkus,
                            count: products.length,
                            instruction: "Select from these SKUs ONLY. Do not invent products."
                        })
                    });
                }
            }
            
            // Send tool results back and get final response
            messages.push(aiMessage);
            messages.push({
                role: "tool",
                content: toolResults[0].output,
                tool_call_id: toolResults[0].tool_call_id
            });
            
            // Update system prompt with new whitelist
            messages[0].content = buildSystemPrompt(sessionState, session.currentWhitelist);
            
            // Get final JSON response from AI
            response = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: messages,
                response_format: { type: "json_object" },
                temperature: 0.3
            });
            
            aiMessage = response.choices[0].message;
        }
        
        // Parse AI JSON output
        let aiOutput;
        try {
            aiOutput = JSON.parse(aiMessage.content);
            console.log(`✅ AI returned JSON:`, JSON.stringify(aiOutput, null, 2));
        } catch (e) {
            console.error(`❌ AI did not return valid JSON:`, aiMessage.content);
            aiOutput = {
                intent: 'clarification',
                intro_copy: "I'd love to help you find the perfect outdoor furniture.",
                selected_skus: [],
                commercial_signals: { customer_sentiment: 'neutral', bundle_candidate: false },
                closing_question: "Are you looking for a lounge set or a dining set?"
            };
        }
        
        // CRITICAL: Validate SKUs against whitelist
        if (aiOutput.selected_skus && aiOutput.selected_skus.length > 0) {
            const validation = validateSkusAgainstWhitelist(
                aiOutput.selected_skus, 
                session.currentWhitelist, 
                sessionId
            );
            
            // ONLY use approved SKUs
            aiOutput.selected_skus = validation.approved;
            
            if (validation.rejected.length > 0) {
                console.log(`🛡️ Blocked ${validation.rejected.length} hallucinated SKUs`);
            }
        }
        
        // ASSEMBLE RESPONSE (Server renders products, not AI)
        const finalResponse = await assembleResponse(aiOutput, sessionId);
        
        console.log(`📤 Response assembled (${finalResponse.length} chars)`);
        console.log(`${'='.repeat(60)}\n`);
        
        res.json({
            response: finalResponse,
            sessionId: sessionId
        });
        
    } catch (error) {
        console.error('❌ Chat error:', error);
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
        version: '13.1 - Phase 1 Server-Side Rendering',
        architecture: 'AI outputs JSON → Server validates → Server renders',
        products_loaded: Object.keys(productIndex.bySku).length,
        shopify_configured: !!SHOPIFY_ACCESS_TOKEN,
        openai_configured: !!process.env.OPENAI_API_KEY
    });
});

app.get('/debug-products', (req, res) => {
    const products = Object.values(productIndex.bySku).slice(0, 20).map(p => ({
        sku: p.product_identity?.sku,
        name: p.product_identity?.product_name,
        category: p.description_and_category?.primary_category
    }));
    
    res.json({
        total_products: Object.keys(productIndex.bySku).length,
        sample: products
    });
});

app.get('/debug-cache', (req, res) => {
    const entries = [];
    for (const [sku, entry] of SHOPIFY_CACHE.entries()) {
        entries.push({
            sku,
            price: entry.data?.price,
            stock: entry.data?.stock,
            age_seconds: Math.round((Date.now() - entry.timestamp) / 1000)
        });
    }
    
    res.json({
        cache_size: SHOPIFY_CACHE.size,
        ttl_minutes: CACHE_TTL_MS / 60000,
        entries
    });
});

app.get('/debug-session/:sessionId', (req, res) => {
    const session = sessions.get(req.params.sessionId);
    
    if (!session) {
        return res.json({ 
            error: 'Session not found',
            available: [...sessions.keys()].slice(0, 5)
        });
    }
    
    res.json({
        messageCount: session.messageCount,
        whitelist: session.currentWhitelist,
        whitelistCount: session.currentWhitelist.length,
        commercial: session.commercial
    });
});

// Serve chat interface
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'chat.html'));
});

app.get('/widget', (req, res) => {
    res.sendFile(path.join(__dirname, 'widget.html'));
});

// ============================================
// SERVER STARTUP
// ============================================

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🚀 GWEN Phase 1 - Server-Side Rendering`);
    console.log(`   Version: 13.1`);
    console.log(`   Port: ${port}`);
    console.log(`${'='.repeat(60)}`);
    console.log(`\n📋 ARCHITECTURE:`);
    console.log(`   Customer → AI outputs JSON (SKUs only)`);
    console.log(`            → Server validates against whitelist`);
    console.log(`            → Server renders product cards`);
    console.log(`            → Customer sees verified output`);
    console.log(`\n🛡️ HALLUCINATION PREVENTION:`);
    console.log(`   ✅ AI outputs JSON only - never product names`);
    console.log(`   ✅ SKUs validated against search whitelist`);
    console.log(`   ✅ Products rendered from verified database`);
    console.log(`   ✅ Out-of-stock products filtered out`);
    console.log(`\n📦 DATA:`);
    console.log(`   Products: ${Object.keys(productIndex.bySku).length}`);
    console.log(`   Inventory: ${inventoryData.length} records`);
    console.log(`\n🔧 CONFIG:`);
    console.log(`   OpenAI: ${process.env.OPENAI_API_KEY ? '✅' : '❌'}`);
    console.log(`   Shopify: ${SHOPIFY_ACCESS_TOKEN ? '✅' : '⚠️ Not configured'}`);
    console.log(`   Database: ${pool ? '✅' : '⚠️ Not configured'}`);
    console.log(`\n${'='.repeat(60)}\n`);
});

module.exports = app;
