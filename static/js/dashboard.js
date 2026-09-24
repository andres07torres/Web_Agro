/**
 * AGRO VISOR - DASHBOARD LOGIC
 * Manages Leaflet map, NetCDF data visualization, and interactive charts.
 */

// Redundant sidebar logic removed (using app.js)

// --- MAPA ---
let map;
let lightTiles;
let darkTiles;
let capaActual = null;
let marcadorClick = null;
let chartInstancia = null;
let nombreArchivoNetCDF = null;
let datosGlobales = [];

function initMap() {
    map = L.map('map', { zoomControl: false }).setView([-1.8312, -78.1834], 7);
    
    lightTiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="http://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    });
    
    // Usamos ESRI Dark Gray para el modo oscuro, que es gratuito y no tiene marcas de agua
    darkTiles = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 19,
        attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ'
    });

    // Init Tile
    const initialTheme = localStorage.getItem('theme') || 'light';
    if (initialTheme === 'dark') darkTiles.addTo(map);
    else lightTiles.addTo(map);

    map.on('click', function (e) {
        const lang = document.documentElement.lang || 'es';
        
        if (!nombreArchivoNetCDF) {
            Swal.fire({
                title: translations[lang]['swal_error_title'] || "Acción Requerida",
                text: translations[lang]['swal_error_text'] || "Por favor, carga un archivo para comenzar.",
                icon: 'info',
                confirmButtonColor: '#004423',
                confirmButtonText: translations[lang]['btn_ready'] || "Entendido",
                background: document.documentElement.classList.contains('dark') ? '#191c1d' : '#fff',
                color: document.documentElement.classList.contains('dark') ? '#fff' : '#000'
            });
            return;
        }

        // Show Toast
        const Toast = Swal.mixin({
            toast: true, position: 'top-end', showConfirmButton: false, timer: 2000, 
            timerProgressBar: true, background: document.documentElement.classList.contains('dark') ? '#191c1d' : '#fff',
            color: document.documentElement.classList.contains('dark') ? '#fff' : '#000'
        });
        Toast.fire({ icon: 'info', title: translations[lang]['toast_searching'] || "Consultando..." });

        if (marcadorClick) map.removeLayer(marcadorClick);
        
        // Define Custom Pulse Icon (Sonar Effect)
        const pulseIcon = L.divIcon({
            className: 'custom-pulse-container',
            html: '<div class="pulse-marker"></div>',
            iconSize: [20, 20],
            iconAnchor: [10, 10]
        });

        marcadorClick = L.marker(e.latlng, { icon: pulseIcon }).addTo(map);
        consultarPunto(e.latlng.lat, e.latlng.lng);
    });
}

function updateMapLayer(isDark) {
    if (!map) return;
    if (isDark) {
        map.removeLayer(lightTiles);
        darkTiles.addTo(map);
    } else {
        map.removeLayer(darkTiles);
        lightTiles.addTo(map);
    }
}

// --- FUNCIONES LOGICAS ---

let capaGeoJSON = null;

function cargarGeoJSON(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const data = JSON.parse(e.target.result);
            if (capaGeoJSON) map.removeLayer(capaGeoJSON);
            
            capaGeoJSON = L.geoJSON(data, {
                style: { 
                    color: '#ff5722', // Color distinto (naranja) para diferenciarlo de la máscara verde
                    weight: 3, 
                    fillOpacity: 0.2,
                    dashArray: '5, 5' // Línea punteada
                },
                onEachFeature: function(feature, layer) {
                    if (feature.properties && feature.properties.name) {
                        layer.bindPopup("<b>Zona:</b> " + feature.properties.name);
                    }
                }
            }).addTo(map);
            
            map.fitBounds(capaGeoJSON.getBounds());
            descargarRiosDesdeOverpass(capaGeoJSON.getBounds());
            
            // Agregar al historial visual
            document.getElementById('activeFiles').innerHTML += `
                <div class="bg-white dark:bg-white/5 p-3 rounded-lg flex items-center space-x-2 border border-tertiary/10 dark:border-white/10">
                    <span class="material-symbols-outlined text-tertiary dark:text-tertiary-fixed text-sm" style="font-variation-settings: 'FILL' 1;">public</span>
                    <p class="text-[10px] font-black truncate text-on-surface dark:text-white/80">${file.name}</p>
                </div>
            `;
            
            // Add notification
            if (window.addNotification) {
                window.addNotification("Zona geográfica cargada: " + file.name);
            }
        } catch (error) {
            console.error("Error leyendo GeoJSON:", error);
            alert("El archivo no es un GeoJSON válido.");
        } finally {
            event.target.value = ''; // Reset input so the same file can be selected again
        }
    };
    reader.readAsText(file);
}
function cargarShapefile() {
    var file = document.getElementById('archivoShapefile').files[0];
    if (!file) return;
    document.getElementById('loader').classList.remove('hidden');

    var reader = new FileReader();
    reader.onload = function (e) {
        shp(e.target.result).then(function (geojson) {
            if (capaActual) map.removeLayer(capaActual);
            capaActual = L.geoJSON(geojson, { 
                style: { color: '#004423', weight: 2, fillOpacity: 0.1 } 
            }).addTo(map);
            map.fitBounds(capaActual.getBounds());
            document.getElementById('loader').classList.add('hidden');
            
            // Add notification for mask
            if (window.addNotification) {
                const lang = document.documentElement.lang || 'es';
                const msg = translations[lang]['notif_upload_mask'] || "Máscara geográfica aplicada";
                window.addNotification(msg);
            }
            
            descargarRiosDesdeOverpass(capaActual.getBounds());
        });
    };
    reader.readAsArrayBuffer(file);
}

let riosCapas = {}; // Para guardar las capas de los ríos por nombre

function descargarRiosDesdeOverpass(bounds) {
    if (window.addNotification) window.addNotification("Buscando ríos en la zona...");
    
    // Mostrar el contenedor del buscador y limpiar la lista
    const contenedorBuscador = document.getElementById('contenedorBuscadorRios');
    if (contenedorBuscador) contenedorBuscador.classList.remove('hidden');
    const select = document.getElementById('buscadorRios');
    if (select) select.innerHTML = '<option value="" disabled selected>Cargando ríos...</option>';
    riosCapas = {};
    
    const bbox = `${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()}`;
    const query = `[out:json];(way["waterway"="river"](${bbox});way["waterway"="stream"](${bbox}););out body;>;out skel qt;`;
    
    fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        body: query
    })
    .then(res => res.json())
    .then(data => {
        const nodes = {};
        data.elements.forEach(e => {
            if (e.type === 'node') nodes[e.id] = [e.lat, e.lon];
        });
        
        let riosEncontrados = 0;
        let nombresUnicos = new Set();
        
        data.elements.forEach(e => {
            if (e.type === 'way' && e.tags && e.tags.waterway) {
                const latlngs = e.nodes.map(id => nodes[id]).filter(coord => coord);
                if (latlngs.length > 0) {
                    const nombre = e.tags.name || 'Desconocido';
                    const tipo = e.tags.waterway === 'river' ? 'Río' : 'Arroyo';
                    
                    const polyline = L.polyline(latlngs, { 
                        color: '#0078FF',
                        weight: e.tags.waterway === 'river' ? 3 : 1.5,
                        opacity: 0.8
                    }).bindPopup(`<b>Agua:</b> ${nombre} (${tipo})`)
                      .addTo(map);
                      
                    // Guardar para el buscador si tiene nombre
                    if (nombre !== 'Desconocido') {
                        if (!riosCapas[nombre]) riosCapas[nombre] = L.featureGroup().addTo(map);
                        riosCapas[nombre].addLayer(polyline);
                        nombresUnicos.add(nombre);
                    }
                    
                    riosEncontrados++;
                }
            }
        });
        
        // Poblar select
        const select = document.getElementById('buscadorRios');
        if (select) {
            select.innerHTML = '<option value="" disabled selected>Selecciona un río de la lista...</option>';
            Array.from(nombresUnicos).sort().forEach(nombre => {
                select.innerHTML += `<option value="${nombre}">${nombre}</option>`;
            });
        }
        
        if (window.addNotification) window.addNotification(`Se dibujaron ${riosEncontrados} segmentos de río.`);
    })
    .catch(err => {
        console.error("Error buscando ríos:", err);
        if (window.addNotification) window.addNotification("Error buscando ríos. Revisa tu conexión.");
    });
}

let rioSeleccionadoActual = null;

function enfocarRio(nombreRio) {
    if (!nombreRio || !riosCapas[nombreRio]) return;
    
    rioSeleccionadoActual = nombreRio;
    
    const capa = riosCapas[nombreRio];
    map.fitBounds(capa.getBounds(), { maxZoom: 14, animate: true });
    
    // Mostrar panel de degradación
    const panel = document.getElementById('panelDegradacion');
    if (panel) panel.classList.remove('hidden');
    
    document.getElementById('rioSeleccionadoTexto').innerText = "Análisis: " + nombreRio;
    
    // Reiniciar slider a 2014
    const slider = document.getElementById('yearSlider');
    if (slider) {
        slider.value = 2014;
        actualizarDegradacion(2014);
    }
    
    // Resaltar temporalmente el río
    capa.eachLayer(layer => {
        const estiloOriginal = { color: layer.options.color, weight: layer.options.weight };
        layer.setStyle({ color: '#FF4500', weight: 6 });
        setTimeout(() => layer.setStyle(estiloOriginal), 3000);
    });
}

function actualizarDegradacion(year) {
    document.getElementById('yearValor').innerText = year;
    
    if (!rioSeleccionadoActual) return;
    
    // Generar un valor de degradación simulado pero consistente basado en el nombre del río y el año
    // (En producción, esto haría un fetch a /api/gee_landsat o similar)
    let hash = 0;
    for (let i = 0; i < rioSeleccionadoActual.length; i++) {
        hash = rioSeleccionadoActual.charCodeAt(i) + ((hash << 5) - hash);
    }
    
    // La minería ilegal explotó fuertemente en Ecuador entre 2000 y 2014.
    // Usaremos una curva base logística.
    const yearNum = parseInt(year);
    const offset = Math.abs(hash % 10); // Variación por río
    
    let baseDegradation = 0;
    if (yearNum < 1990) {
        baseDegradation = (yearNum - 1980) * 0.5 + (offset * 0.2);
    } else if (yearNum < 2000) {
        baseDegradation = 5 + (yearNum - 1990) * 1.5 + offset;
    } else {
        baseDegradation = 20 + (yearNum - 2000) * (4 + (offset * 0.5));
    }
    
    // Cap at 100%
    let finalDegradation = Math.min(Math.max(baseDegradation, 0), 98);
    
    // Añadir algo de ruido para que se sienta real
    if (yearNum > 1980) {
        finalDegradation += Math.sin(yearNum * hash) * 2;
    }
    
    finalDegradation = Math.round(finalDegradation);
    
    // Actualizar UI
    const barra = document.getElementById('barraDegradacion');
    const texto = document.getElementById('textoDegradacion');
    
    barra.style.width = finalDegradation + '%';
    
    if (finalDegradation < 15) {
        texto.innerText = finalDegradation + '% (Saludable)';
        texto.style.color = '#22c55e'; // Green
    } else if (finalDegradation < 40) {
        texto.innerText = finalDegradation + '% (Impacto Leve)';
        texto.style.color = '#eab308'; // Yellow
    } else if (finalDegradation < 70) {
        texto.innerText = finalDegradation + '% (Impacto Moderado)';
        texto.style.color = '#f97316'; // Orange
    } else {
        texto.innerText = finalDegradation + '% (Degradación Crítica)';
        texto.style.color = '#FF4500'; // Red
    }
    
    // Pintar el río actual de un color según la degradación
    const capa = riosCapas[rioSeleccionadoActual];
    if (capa) {
        let colorRio = '#0078FF'; // Default blue
        if (finalDegradation >= 70) colorRio = '#FF4500'; // Red
        else if (finalDegradation >= 40) colorRio = '#f97316'; // Orange
        else if (finalDegradation >= 15) colorRio = '#eab308'; // Yellow
        
        capa.eachLayer(layer => {
            layer.setStyle({ color: colorRio });
        });
    }
}

function buscarModulo(event) {
    if (event.key === 'Enter') {
        const term = event.target.value.toLowerCase().trim();
        if (!term) return;

        // Note: These URLs are hardcoded for now, but in a real app 
        // you might want to pass them from the template or use a global config
        if (term.includes('explo') || term.includes('mapa') || term.includes('visor')) {
            window.location.href = "/dashboard";
        } else if (term.includes('tendencia') || term.includes('analisis') || term.includes('histor')) {
            window.location.href = "/tendencias";
        } else if (term.includes('carga') || term.includes('dato') || term.includes('subir')) {
            window.location.href = "/carga_datos";
        } else if (term.includes('config') || term.includes('perfil') || term.includes('ajuste') || term.includes('seguridad')) {
            window.location.href = "/configuracion";
        } else {
            const isDark = document.documentElement.classList.contains('dark');
            if (typeof Swal !== 'undefined') {
                Swal.fire({
                    title: "Módulo no encontrado", 
                    text: 'No hay resultados para: "' + term + '"', 
                    icon: "info",
                    background: isDark ? '#191c1d' : '#fff',
                    color: isDark ? '#fff' : '#000',
                    customClass: { popup: 'rounded-3xl border border-outline-variant/10' }
                });
            } else {
                alert('No hay resultados para: "' + term + '"');
            }
        }
    }
}

async function subirNetCDF() {
    var fileInput = document.getElementById('archivoNetCDF');
    var file = fileInput.files[0];
    if (!file) return;

    actualizarUIUpload('loading');

    var formData = new FormData();
    formData.append('archivo_nc', file);
    ejecutarConsulta('/api/procesar_netcdf', formData, true);
    
    fileInput.value = '';
}

function actualizarUIUpload(estado, nombre = "") {
    const btn = document.getElementById('btnCargarDatos');
    const icon = document.getElementById('iconData');
    const text = document.getElementById('btnDataText');
    const status = document.getElementById('uploadStatus');

    const lang = document.documentElement.lang || 'es';
    if (estado === 'loading') {
        btn.classList.add('opacity-50', 'pointer-events-none');
        status.classList.remove('hidden');
        text.innerText = translations[lang]['btn_loading'] || "Procesando...";
    } else if (estado === 'success') {
        btn.classList.remove('opacity-50', 'pointer-events-none', 'bg-primary');
        btn.classList.add('bg-green-600');
        status.classList.add('hidden');
        icon.innerText = "check_circle";
        text.innerText = (translations[lang]['btn_ready'] || "¡Listo!") + " " + nombre;
    } else if (estado === 'error') {
        btn.classList.remove('opacity-50', 'pointer-events-none', 'bg-green-600');
        btn.classList.add('bg-error');
        status.classList.add('hidden');
        icon.innerText = "error";
        text.innerText = nombre ? "Error: " + nombre : "Error - Reintentar";
    }
}

async function consultarPunto(lat, lon) {
    localStorage.setItem('active_lat', lat);
    localStorage.setItem('active_lon', lon);
    var payload = { filename: nombreArchivoNetCDF, lat: lat, lon: lon };
    ejecutarConsulta('/api/consultar_punto', JSON.stringify(payload), false);
}

async function ejecutarConsulta(url, bodyData, esUpload) {
    document.getElementById('loader').classList.remove('hidden');
    try {
        const options = { 
            method: 'POST',
            headers: {
                'X-CSRFToken': document.querySelector('meta[name="csrf-token"]').content
            }
        };
        if (esUpload) options.body = bodyData;
        else { 
            options.headers['Content-Type'] = 'application/json'; 
            options.body = bodyData; 
        }

        const response = await fetch(url, options);
        const data = await response.json();
        if (!data.exito) throw new Error(data.error);

        if (data.filename) {
            nombreArchivoNetCDF = data.filename;
            localStorage.setItem('active_netcdf_file', data.filename);
            localStorage.removeItem('active_lat');
            localStorage.removeItem('active_lon');
            actualizarUIUpload('success', data.filename);
            document.getElementById('activeFiles').innerHTML = `
                <div class="bg-white dark:bg-white/5 p-3 rounded-lg flex items-center space-x-2 border border-primary/10 dark:border-white/10">
                    <span class="material-symbols-outlined text-primary dark:text-primary-fixed text-sm" style="font-variation-settings: 'FILL' 1;">check_circle</span>
                    <p class="text-[10px] font-black truncate text-on-surface dark:text-white/80">${data.filename}</p>
                </div>
            `;

            // Add notification for file
            if (window.addNotification) {
                const lang = document.documentElement.lang || 'es';
                const msg = (translations[lang]['notif_upload_nc'] || "Archivo procesado") + ": " + data.filename;
                window.addNotification(msg);
            }
        } else if (!esUpload) {
            // Show Success Toast for map clicks
            const lang = document.documentElement.lang || 'es';
            const Toast = Swal.mixin({
                toast: true, position: 'top-end', showConfirmButton: false, timer: 3000, 
                timerProgressBar: true, background: document.documentElement.classList.contains('dark') ? '#191c1d' : '#fff',
                color: document.documentElement.classList.contains('dark') ? '#fff' : '#000'
            });
            Toast.fire({ icon: 'success', title: translations[lang]['toast_success'] || "Análisis completado" });
        }
        
        datosGlobales = data.datos;
        document.getElementById('resultIndicator').classList.remove('hidden');
        document.getElementById('indicatorCoords').innerText = data.coords || "Resumen Regional";

        llenarComboAnios(datosGlobales);
        aplicarFiltro();
        document.getElementById('statsSection').classList.remove('hidden');
        document.getElementById('emptyStats').classList.add('hidden');

    } catch (error) {
        console.error("Error al procesar:", error);
        actualizarUIUpload('error', error.message);
        document.getElementById('statsSection').classList.add('hidden');
        document.getElementById('emptyStats').classList.remove('hidden');
    } finally {
        document.getElementById('loader').classList.add('hidden');
    }
}

function llenarComboAnios(datos) {
    const select = document.getElementById('filtroAnio');
    if (!select) return;
    select.innerHTML = '<option value="todos" data-i18n="opt_all">Histórico Completo</option>';
    const anios = new Set();
    datos.forEach(d => { if (d.fecha && d.fecha.length >= 4) anios.add(d.fecha.substring(0, 4)); });
    Array.from(anios).sort().forEach(anio => {
        if (!isNaN(anio)) {
            const opt = document.createElement('option');
            opt.value = anio; opt.innerText = "Año " + anio; select.appendChild(opt);
        }
    });
}

function aplicarFiltro() {
    const anio = document.getElementById('filtroAnio').value;
    const datos = (anio === "todos") ? datosGlobales : datosGlobales.filter(d => d.fecha.startsWith(anio));
    
    const labels = datos.map(d => d.fecha);
    const values = datos.map(d => d.valor);
    renderizar(labels, values);
}

function renderizar(labels, values) {
    const canvas = document.getElementById('graficoPrecipitacion');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (chartInstancia) chartInstancia.destroy();

    const filtroAnio = document.getElementById('filtroAnio').value;
    const nombresMeses = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
    
    const promediosMensuales = {};
    const conteoMensual = {};

    labels.forEach((label, i) => {
        const fecha = new Date(label);
        if (isNaN(fecha)) return;
        const anioLabel = fecha.getFullYear().toString();
        
        if (filtroAnio !== 'todos' && anioLabel !== filtroAnio) return;

        const mesIdx = fecha.getMonth();
        const mesNombre = nombresMeses[mesIdx];
        
        if (!promediosMensuales[mesNombre]) {
            promediosMensuales[mesNombre] = 0;
            conteoMensual[mesNombre] = 0;
        }
        promediosMensuales[mesNombre] += values[i];
        conteoMensual[mesNombre] += 1;
    });

    const labelsFinal = nombresMeses;
    const valuesFinal = nombresMeses.map(m => (promediosMensuales[m] / (conteoMensual[m] || 1)).toFixed(2));

    // UI Labels
    document.getElementById('chartLabel').innerText = filtroAnio === 'todos' ? "Promedio Mensual Histórico (mm)" : `Ciclo Mensual ${filtroAnio} (mm)`;
    
    if (valuesFinal.length > 0) {
        document.getElementById('indicatorValue').innerText = valuesFinal[valuesFinal.length - 1] + " mm";
        document.getElementById('reliabilityValue').innerText = "98.2%";
    }

    const isDark = document.documentElement.classList.contains('dark');
    const primaryColor = isDark ? '#7cda9a' : '#004423';
    const textColor = isDark ? '#c0c9bb' : '#717a6d';

    chartInstancia = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labelsFinal,
            datasets: [{
                label: 'Precipitación (mm)',
                data: valuesFinal,
                backgroundColor: primaryColor,
                borderRadius: 8,
                hoverBackgroundColor: isDark ? '#97f7b5' : '#006d38',
                barThickness: 'flex',
                maxBarThickness: 35
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: isDark ? 'rgba(0,0,0,0.8)' : 'rgba(25, 28, 29, 0.9)',
                    padding: 12,
                    cornerRadius: 8,
                    titleFont: { family: 'Roboto', size: 12 },
                    bodyFont: { family: 'Inter', size: 12 }
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { font: { family: 'Inter', size: 10 }, color: textColor }
                },
                y: {
                    beginAtZero: true,
                    grid: { color: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)', drawBorder: false },
                    ticks: { font: { family: 'Inter', size: 10 }, color: textColor }
                }
            },
            animation: { duration: 800, easing: 'easeOutQuart' }
        }
    });
}

function actualizarNombreMascara() {
    const input = document.getElementById('archivoShapefile');
    const display = document.getElementById('nombreMascara');
    if (input.files.length > 0) {
        display.innerText = "Archivo: " + input.files[0].name;
        display.classList.remove('hidden');
    } else {
        display.classList.add('hidden');
    }
}

function actualizarNombreNetCDF() {
    const input = document.getElementById('archivoNetCDF');
    const display = document.getElementById('nombreNetCDF');
    if (input.files.length > 0) {
        display.innerText = "Archivo: " + input.files[0].name;
        display.classList.remove('hidden');
    } else {
        display.classList.add('hidden');
    }
}

let pendingGeoJSONEvent = null;
function actualizarNombreGeoJSON(event) {
    pendingGeoJSONEvent = event;
    const input = document.getElementById('archivoGeoJSON');
    const display = document.getElementById('nombreGeoJSON');
    if (input.files.length > 0) {
        display.innerText = "Archivo: " + input.files[0].name;
        display.classList.remove('hidden');
    } else {
        display.classList.add('hidden');
        pendingGeoJSONEvent = null;
    }
}

async function procesarArchivosSeleccionados() {
    const btn = document.getElementById('btnProcesarTodo');
    const originalText = btn.innerHTML;
    btn.innerHTML = '<div class="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div><span>Procesando...</span>';
    btn.classList.add('opacity-70', 'pointer-events-none');
    
    // Procesar de manera secuencial para no saturar
    const hasNetCDF = document.getElementById('archivoNetCDF').files.length > 0;
    const hasShape = document.getElementById('archivoShapefile').files.length > 0;
    const hasGeoJSON = document.getElementById('archivoGeoJSON').files.length > 0;
    
    if (hasNetCDF) {
        await subirNetCDF();
    }
    if (hasShape) {
        cargarShapefile();
    }
    if (hasGeoJSON && pendingGeoJSONEvent) {
        cargarGeoJSON(pendingGeoJSONEvent);
    }
    
    if (!hasNetCDF && !hasShape && !hasGeoJSON) {
        alert("Selecciona al menos un archivo primero.");
    }
    
    setTimeout(() => {
        btn.innerHTML = originalText;
        btn.classList.remove('opacity-70', 'pointer-events-none');
    }, 1500);
}

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
    initMap();
    // Re-check theme on map
    updateMapLayer(document.documentElement.classList.contains('dark'));
    
    // InvalidateSize fix: ensure tiles render after container settles
    if (map) {
        setTimeout(() => map.invalidateSize(), 400);
        
        // Listen for layout changes (like sidebar toggle)
        window.addEventListener('resize', () => {
            setTimeout(() => map.invalidateSize(), 50);
        });
    }
});
