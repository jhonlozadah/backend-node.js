require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const csv = require('csv-parser');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const TELEFONO_WHATSAPP = process.env.TELEFONO_WHATSAPP || "51936709598";

// Middlewares
app.use(cors());
app.use(express.json());

// Configuración de Multer (Procesamiento en RAM)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // Límite de 5MB
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Formato no válido. Solo se permiten imágenes.'));
    }
});

const registroConsultas = new Map();

function puedeConsultarHoy(ipCliente) {
    // Nota: Si deseas desactivar el límite temporalmente para hacer pruebas rápidas,
    // simplemente descomenta la siguiente línea:
    // return true;

    const hoy = new Date().toISOString().split('T')[0];
    const registro = registroConsultas.get(ipCliente);

    if (registro && registro.fecha === hoy) return false;

    registroConsultas.set(ipCliente, { fecha: hoy });
    return true;
}

let catalogoEnMemoria = [];

function cargarCatalogo() {
    const tempArray = [];
    fs.createReadStream('productos.csv')
        .pipe(csv())
        .on('data', (row) => {
            tempArray.push({
                nombre: row['Nombre'] || '',
                inventario: parseInt(row['Inventario']) || 0,
                existencias: row['¿Existencias?'] || '',
                categorias: row['Categorías'] || '',
                etiquetas: row['Etiquetas'] || '',
                precio: row['Precio normal'] || row['Precio rebajado'] || 'Consulte'
            });
        })
        .on('end', () => {
            catalogoEnMemoria = tempArray;
            console.log(`📦 Catálogo cargado en memoria: ${catalogoEnMemoria.length} productos listos.`);
        });
}

// Genera un texto plano con el catálogo para inyectarlo en el prompt de la IA
function obtenerCatalogoParaIA() {
    return catalogoEnMemoria.map(prod => 
        `- Nombre: ${prod.nombre} | Uso: ${prod.categorias} ${prod.etiquetas}`
    ).join('\n');
}

function buscarRecomendacionesPorNombre(nombresRecomendadosIA) {
    const productosDisponibles = [];
    const productosAgotados = [];

    // Validar que la IA haya devuelto un array
    if (!Array.isArray(nombresRecomendadosIA)) {
        return { productosDisponibles, productosAgotados };
    }

    catalogoEnMemoria.forEach(prod => {
        // Buscamos si el nombre del producto está en la lista que recomendó la IA
        if (nombresRecomendadosIA.includes(prod.nombre)) {
            const tieneStock = prod.inventario > 0 || prod.existencias === '1' || prod.existencias.toLowerCase() === 'instock';
            const productoInfo = { Producto: prod.nombre, Precio: `S/ ${prod.precio}` };

            if (tieneStock) {
                productoInfo.Stock = prod.inventario > 0 ? prod.inventario : 'Disponible';
                productosDisponibles.push(productoInfo);
            } else {
                productoInfo.Stock = 'A pedido';
                productosAgotados.push(productoInfo);
            }
        }
    });

    return { productosDisponibles, productosAgotados };
}

// Función auxiliar para crear pausas
const esperar = (ms) => new Promise(resolve => setTimeout(resolve, ms));

app.post('/api/diagnosticar', upload.single('imagen'), async (req, res) => {
    const ipCliente = req.ip || req.connection.remoteAddress;

    if (!req.file) {
        return res.status(400).json({ success: false, mensaje: "Debes subir una imagen de la patología." });
    }

    if (!puedeConsultarHoy(ipCliente)) {
        return res.status(429).json({
            success: false,
            mensaje: "Has superado el límite de 1 diagnóstico por día. Inténtalo el día de mañana."
        });
    }

    try {
        const systemInstructions = `Eres un ingeniero civil y patólogo de la construcción experto. 
        Devuelve ÚNICAMENTE un objeto JSON con esta estructura exacta:
        {
            "diagnostico_tecnico": "Explicación técnica de 3 líneas evaluando el problema y la solución.",
            "productos_recomendados": ["Nombre Exacto Producto 1", "Nombre Exacto Producto 2"]
        }

        CATÁLOGO DE PRODUCTOS DISPONIBLES:
        ${obtenerCatalogoParaIA()}

        IMPORTANTE:
        1. Recomienda entre 1 y 3 productos de este catálogo que solucionen el problema del cliente de forma integral.
        2. Los textos en el array "productos_recomendados" DEBEN ser idénticos a los nombres listados en el catálogo proporcionado. No inventes productos que no estén en la lista.`;

        const imagePart = {
            inlineData: {
                data: req.file.buffer.toString("base64"),
                mimeType: req.file.mimetype
            }
        };

        const maxIntentos = 3;
        let diagnosticoIA = null;

        for (let intento = 1; intento <= maxIntentos; intento++) {
            try {
                console.log(`🤖 Intento ${intento} de ${maxIntentos} con: gemini-2.5-flash...`);
                const model = genAI.getGenerativeModel({
                    model: "gemini-2.5-flash",
                    generationConfig: { responseMimeType: "application/json" }
                });

                const result = await model.generateContent([prompt, imagePart]);
                const response = await result.response;
                diagnosticoIA = JSON.parse(response.text());

                console.log(`✅ Análisis exitoso en el intento ${intento}`);
                break; // Rompemos el ciclo si tuvo éxito

            } catch (errorGeneracion) {
                // Si es un error 503 y aún nos quedan intentos...
                if ((errorGeneracion.status === 503 || (errorGeneracion.message && errorGeneracion.message.includes('503'))) && intento < maxIntentos) {
                    console.log(`⚠️ Servidor de Google ocupado. Esperando 2 segundos para reintentar...`);
                    await esperar(2000); // El servidor "duerme" 2 segundos y vuelve a intentar
                    continue;
                }
                // Si ya no quedan intentos o es otro error grave, lo disparamos
                throw errorGeneracion;
            }
        }

        if (!diagnosticoIA) {
            throw new Error("No se pudo obtener respuesta de la IA después de varios intentos.");
        }

        if (diagnosticoIA.etiqueta_busqueda === "no_identificado") {
            registroConsultas.delete(ipCliente);
            return res.json({
                success: false,
                mensaje: "La imagen no es clara o no parece ser un problema de construcción. Por favor, sube una foto más nítida y visible."
            });
        }

        const { productosDisponibles, productosAgotados } = buscarRecomendaciones(diagnosticoIA);

        let whatsappLink = null;
        if (productosDisponibles.length === 0 && productosAgotados.length > 0) {
            const mensajeWsp = encodeURIComponent(`Hola, usé el diagnóstico IA en la web. Necesito cotizar un producto para solucionar: ${diagnosticoIA.diagnostico_cliente}`);
            whatsappLink = `https://wa.me/${TELEFONO_WHATSAPP}?text=${mensajeWsp}`;
        }

        res.json({
            success: true,
            diagnostico: diagnosticoIA.diagnostico_cliente,
            patologia_detectada: diagnosticoIA.etiqueta_busqueda,
            solucion_inmediata: productosDisponibles,
            solucion_a_pedido: productosAgotados,
            enlace_whatsapp: whatsappLink
        });

    } catch (error) {
        console.error("❌ Error interno del servidor:", error.message || error);
        registroConsultas.delete(ipCliente);

        let mensajeCliente = "Error al procesar la imagen. Inténtalo de nuevo.";
        if (error.status === 503 || (error.message && error.message.includes('503'))) {
            mensajeCliente = "Nuestros servidores de IA están procesando demasiadas imágenes. Por favor, vuelve a tocar el botón en unos segundos.";
        }

        res.status(500).json({ success: false, mensaje: mensajeCliente });
    }
});

app.post('/api/diagnostico-completo', upload.single('imagen'), async (req, res) => {
    try {
        const { problema, superficie, area, edificacion } = req.body;

        // 1. DICCIONARIO DE MAPEO (Relación exacta Frontend -> Etiqueta CSV)
        const mapaEtiquetas = {
            "Filtraciones / Goteras": "filtracion_activa",
            "Humedad": "humedad_ascendente",
            "Fisuras / Grietas": "fisura_superficial",
            "Juntas dañadas": "junta_dilatacion",
            "Infiltración de agua": "filtracion_activa"
        };

        // Verificamos si el problema elegido en el HTML está en nuestro diccionario
        const etiquetaForzada = mapaEtiquetas[problema];

        const promptContext = `El cliente reporta el siguiente problema: "${problema}" en una superficie de "${superficie}" (${area}m², edificación ${edificacion}).`;

        // 2. INSTRUCCIONES BLINDADAS
        // Si existe una etiqueta mapeada, OBLIGAMOS a la IA a usarla. 
        // Si no existe (ej. eligió "Otro problema"), le damos la lista para que elija.
        const systemInstructions = `Eres un ingeniero civil y patólogo de la construcción experto. 
        Devuelve ÚNICAMENTE un objeto JSON con esta estructura exacta:
        {
            "diagnostico_tecnico": "Explicación técnica de 3 líneas evaluando el problema y la solución.",
            "productos_recomendados": ["Nombre Exacto Producto 1", "Nombre Exacto Producto 2"]
        }

        CATÁLOGO DE PRODUCTOS DISPONIBLES:
        ${obtenerCatalogoParaIA()}

        IMPORTANTE:
        1. Recomienda entre 1 y 3 productos de este catálogo que solucionen el problema del cliente de forma integral.
        2. Los textos en el array "productos_recomendados" DEBEN ser idénticos a los nombres listados en el catálogo proporcionado. No inventes productos que no estén en la lista.`;

        let iaData;
        if (req.file) {
            // ==========================================
            // RUTEO A: HAY IMAGEN -> USAMOS GEMINI
            // ==========================================
            console.log("📸 Procesando Paso 6 CON imagen usando Gemini...");
            const promptFinal = `${systemInstructions}\n\n${promptContext}\nAnaliza también la imagen adjunta para confirmar o precisar el diagnóstico.`;

            const model = genAI.getGenerativeModel({
                model: "gemini-2.5-flash",
                generationConfig: { responseMimeType: "application/json" }
            });

            const imagePart = {
                inlineData: {
                    data: req.file.buffer.toString("base64"),
                    mimeType: req.file.mimetype
                }
            };

            const result = await model.generateContent([promptFinal, imagePart]);
            const response = await result.response;
            iaData = JSON.parse(response.text());

        } else {
            // ==========================================
            // RUTEO B: SOLO TEXTO -> USAMOS OPENROUTER
            // ==========================================
            console.log("📝 Procesando Paso 6 SOLO texto usando OpenRouter...");

            const response = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
                model: "openai/gpt-4o-mini",
                messages: [
                    { role: "system", content: systemInstructions },
                    { role: "user", content: `${promptContext}\nBásate estrictamente en estos datos de texto para dar el diagnóstico.` }
                ],
                response_format: { type: "json_object" }
            }, {
                headers: {
                    "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
                    "HTTP-Referer": "http://localhost:3000",
                    "X-Title": "DiagnosticoIA"
                }
            });

            iaData = JSON.parse(response.data.choices[0].message.content);
        }

        // 3. BÚSQUEDA DE PRODUCTOS EXACTOS RECOMENDADOS POR LA IA
        console.log(`🏷️ Productos elegidos por la IA:`, iaData.productos_recomendados);
        const resultados = buscarRecomendacionesPorNombre(iaData.productos_recomendados);
        const productosSeleccionados = [...resultados.productosDisponibles, ...resultados.productosAgotados];

        // 4. RESPUESTA AL FRONTEND
        res.json({
            success: true,
            titulo_sistema: "Recomendación Técnica",
            descripcion_sistema: iaData.diagnostico_tecnico,
            analisis_ia: [
                `Diagnóstico: ${iaData.diagnostico_tecnico}`,
                `Contexto: Problema reportado como '${problema}' en ${superficie} de ${area}m².`,
                "Recomendación: Aplicar los siguientes productos sugeridos según su ficha técnica."
            ],
            // Mapeamos solo los nombres para mantener compatibilidad con tu Frontend actual
            productos: productosSeleccionados.map(p => p.Producto)
        });

    } catch (error) {
        console.error("❌ Error en el procesamiento (Paso 6):", error.response ? error.response.data : error.message);
        res.status(500).json({ success: false, mensaje: "Error al procesar diagnóstico." });
    }
});
const PORT = process.env.PORT || 3000;

cargarCatalogo();

app.listen(PORT, () => {
    console.log(`🚀 Servidor IA corriendo en el puerto ${PORT}`);
});