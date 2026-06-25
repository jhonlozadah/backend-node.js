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
const TELEFONO_WHATSAPP = process.env.TELEFONO_WHATSAPP || "51902707635";

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

// ============================================================================
// 1. SISTEMA DE LÍMITE DIARIO (RATE LIMITING)
// ============================================================================
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

function buscarRecomendaciones(diagnosticoIA) {
    const productosDisponibles = [];
    const productosAgotados = [];
    const palabraClave = diagnosticoIA.etiqueta_busqueda.toLowerCase();

    catalogoEnMemoria.forEach(prod => {
        const textoParaBuscar = `${prod.nombre} ${prod.categorias} ${prod.etiquetas}`.toLowerCase();

        if (textoParaBuscar.includes(palabraClave)) {
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
        const prompt = `Eres un ingeniero civil y patólogo de la construcción experto. 
        Analiza la imagen adjunta y devuelve ÚNICAMENTE un objeto JSON evaluando el problema.
        
        Estructura requerida:
        {
          "diagnostico_cliente": "Explicación técnica pero fácil de entender de 3 líneas sobre el problema visualizado.",
          "etiqueta_busqueda": "ELIGE_UNA_OPCION"
        }

        Para "etiqueta_busqueda", analiza cuidadosamente la imagen y elige ESTRICTAMENTE UNA de estas opciones del catálogo, basándote en estos criterios visuales:
        - moho_hongos: Manchas orgánicas negras/verdes por humedad constante.
        - filtracion_activa: Paso de agua evidente a través de techos, muros o losas.
        - humedad_ascendente: Desprendimiento o salitre en la PARTE BAJA de los muros.
        - grieta_estructural: Aberturas anchas y profundas (>3mm).
        - fisura_superficial: Aberturas como tela de araña en tarrajeo o pintura.
        - borde_danado: Despostillamientos en esquinas de columnas o vigas.
        - cangrejera: "Nido de abejas", falta de pasta, piedras visibles.
        - junta_dilatacion: Separaciones perfectas entre bloques o losas.
        - acero_expuesto: Varillas de fierro oxidadas visibles.
        - acelerante: Necesidad operativa (frío, lluvia o prisa).
        - no_identificado: Imagen borrosa o sin relación con construcción.`;

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

        const systemPrompt = `Eres un ingeniero civil y patólogo estructural experto. Tu tarea es analizar los datos de un problema de construcción y recomendar un sistema de reparación.
        Debes recomendar productos reales unicamente de la marca SIKA, que sean adecuados para el problema, analiza los datos y devuelve SOLO un JSON:
        {
            "diagnostico_tecnico": "Explicación breve",
            "etiqueta_busqueda": "PALABRA_CLAVE_PARA_BUSCAR_EN_CSV"
        }
        Las palabras clave posibles son: Sika, sellador, impermeabilizante, reparador, Sikaflex, Rep 500, mortero.`;

        const response = await axios.post("https://openrouter.ai/api/v1/chat/completions", {
            model: "openai/gpt-4o-mini", // Modelo estable y económico
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: `Problema: ${problema}, Superficie: ${superficie}, Edificacion: ${edificacion}` }
            ],
            response_format: { type: "json_object" }
        }, {
            headers: {
                "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
                "HTTP-Referer": "http://localhost:3000",
                "X-Title": "DiagnosticoIA"
            }
        });

        const iaData = JSON.parse(response.data.choices[0].message.content);

        // AQUÍ ESTÁ EL FILTRO DE TU CSV
        const resultados = buscarRecomendaciones(iaData);

        const productosSeleccionados = resultados.productosDisponibles
            .sort(() => 0.5 - Math.random())
            .slice(0, 4);

        res.json({
            success: true,
            titulo_sistema: "Recomendación Técnica",
            descripcion_sistema: iaData.diagnostico_tecnico,
            analisis_ia: [
                `Diagnóstico: ${iaData.diagnostico_tecnico}`,
                `Contexto: Problema en ${superficie} de ${area}m² (${edificacion}).`,
                "Recomendación: Aplicar los siguientes productos sugeridos según su ficha técnica."
            ],
            // Usamos la lista filtrada, aleatoria y limitada
            productos: productosSeleccionados.map(p => p.Producto)
        });

    } catch (error) {
        console.error("❌ Error:", error.message);
        res.status(500).json({ success: false, mensaje: "Error al procesar diagnóstico." });
    }
});

const PORT = process.env.PORT || 3000;

cargarCatalogo();

app.listen(PORT, () => {
    console.log(`🚀 Servidor IA corriendo en el puerto ${PORT}`);
    console.log(`👉 Endpoint disponible en: http://localhost:${PORT}/api/diagnosticar`);
});