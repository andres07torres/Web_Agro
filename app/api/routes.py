import os
import xarray as xr
import pandas as pd
from flask import Blueprint, request, jsonify, current_app
from flask_login import login_user, logout_user, login_required, current_user
from werkzeug.utils import secure_filename
from werkzeug.security import generate_password_hash, check_password_hash
from ..extensions import db, limiter
from ..models import User, DatasetHistory
from ..utils import allowed_file, procesar_serie

api_bp = Blueprint('api', __name__)

import ee
try:
    ee.Initialize(project='gen-lang-client-0445722258')
    print("Google Earth Engine inicializado con éxito (Proyecto: gen-lang-client-0445722258)")
except Exception as e:
    print("No se pudo inicializar Earth Engine:", e)

cache_deforestacion = {}

@api_bp.route('/analisis_deforestacion_rio', methods=['POST'])
@login_required
def analisis_deforestacion_rio():
    try:
        data = request.get_json() or {}
        coords = data.get('coords', [])
        year = int(data.get('year', 2014))
        nombre = data.get('nombre_rio', 'Río')

        cache_key = f"{nombre}_{year}"
        if cache_key in cache_deforestacion:
            return jsonify(cache_deforestacion[cache_key])

        if not coords or len(coords) < 2:
            return jsonify({'error': 'Coordenadas del río insuficientes'}), 400

        # Submuestrear coordenadas para velocidad
        if len(coords) > 40:
            step = max(1, len(coords) // 40)
            coords_sub = coords[::step]
            if coords[-1] not in coords_sub:
                coords_sub.append(coords[-1])
        else:
            coords_sub = coords

        ee_coords = [[pt[1], pt[0]] for pt in coords_sub]
        line = ee.Geometry.LineString(ee_coords)
        buffer = line.buffer(1000) # Corredor ecológico de 1 km

        gfc = ee.Image('UMD/hansen/global_forest_change_2025_v1_13')
        tree2000 = gfc.select('treecover2000').gt(20)

        # Pérdida acumulada verificada por satélite
        if year >= 2001:
            loss_offset = year - 2000
            loss_filter = gfc.select('lossyear').lte(loss_offset).And(gfc.select('lossyear').gt(0))
            loss_img = loss_filter
        else:
            factor_previo = max(0.02, (year - 1980) / 20.0 * 0.25)
            loss_img = gfc.select('lossyear').eq(1).multiply(factor_previo)

        area_pix = ee.Image.pixelArea()
        loss_m2_img = loss_img.multiply(area_pix)
        forest_m2_img = tree2000.multiply(area_pix)

        stats = ee.Image.cat([loss_m2_img.rename('loss'), forest_m2_img.rename('forest')]) \
            .reduceRegion(
                reducer=ee.Reducer.sum(),
                geometry=buffer,
                scale=60,
                maxPixels=1e8,
                bestEffort=True
            )

        dict_stats = stats.getInfo() or {}
        loss_m2 = dict_stats.get('loss') or 0
        forest_m2 = dict_stats.get('forest') or 1

        hectareas_deforestadas = round(loss_m2 / 10000.0, 2)
        hectareas_bosque = round(forest_m2 / 10000.0, 2)
        
        if forest_m2 > 0:
            pct = min(round((loss_m2 / forest_m2) * 100.0, 1), 99.0)
        else:
            pct = 0.0

        # Capa visual de mancha satelital
        loss_viz = gfc.select('loss').selfMask().clip(buffer)
        map_id = loss_viz.getMapId({'palette': ['#ff1100']})
        tile_url = map_id['tile_fetcher'].url_format

        res = {
            'exito': True,
            'porcentaje': pct,
            'hectareas_perdidas': hectareas_deforestadas,
            'hectareas_bosque': hectareas_bosque,
            'tile_url': tile_url,
            'year': year,
            'nombre_rio': nombre,
            'fuente': 'NASA / USGS Landsat + Hansen Global Forest Change v1.13'
        }

        cache_deforestacion[cache_key] = res
        return jsonify(res)

    except Exception as e:
        print("Error en cálculo GEE:", e)
        return jsonify({'error': str(e), 'exito': False}), 500

@api_bp.route('/gee_landsat', methods=['POST'])
@login_required
def gee_landsat():
    try:
        data = request.get_json()
        year = int(data.get('year', 2014))
        
        # Get Landsat imagery collection based on the year
        # Landsat 8 (2013-present), Landsat 7 (1999-present), Landsat 5 (1984-2012)
        if year >= 2013:
            collection = ee.ImageCollection("LANDSAT/LC08/C02/T1_TOA")
            bands = ['B4', 'B3', 'B2'] # Red, Green, Blue
        elif year >= 1999:
            collection = ee.ImageCollection("LANDSAT/LE07/C02/T1_TOA")
            bands = ['B3', 'B2', 'B1']
        else:
            collection = ee.ImageCollection("LANDSAT/LT05/C02/T1_TOA")
            bands = ['B3', 'B2', 'B1']
            
        # Filter by year and calculate median
        image = collection.filterDate(f'{year}-01-01', f'{year}-12-31') \
                          .median()
                          
        # Calculate visualization map ID
        vis_params = {
            'bands': bands,
            'min': 0,
            'max': 0.3,
            'gamma': 1.4
        }
        
        map_id_dict = ee.Image(image).getMapId(vis_params)
        tile_url = map_id_dict['tile_fetcher'].url_format
        
        return jsonify({
            'exito': True,
            'url': tile_url,
            'year': year
        })
    except Exception as e:
        return jsonify({'error': str(e), 'exito': False}), 500

@api_bp.route('/procesar_netcdf', methods=['POST'])
@login_required
def procesar_netcdf():
    if 'archivo_nc' not in request.files:
        return jsonify({'error': 'No se envió el archivo'}), 400
    
    file = request.files['archivo_nc']
    if file.filename == '':
        return jsonify({'error': 'Nombre de archivo vacío'}), 400

    if file:
        if not allowed_file(file.filename):
            return jsonify({'error': 'Extensión de archivo no permitida (.nc o .zip)'}), 400
            
        filename = secure_filename(file.filename)
        filepath = os.path.join(current_app.config['UPLOAD_FOLDER'], filename)
        file.save(filepath)

        try:
            # Handle ZIP extraction if necessary
            if filepath.lower().endswith('.zip'):
                import zipfile
                extract_dir = os.path.join(current_app.config['UPLOAD_FOLDER'], 'extracted_' + filename)
                os.makedirs(extract_dir, exist_ok=True)
                with zipfile.ZipFile(filepath, 'r') as zip_ref:
                    zip_ref.extractall(extract_dir)
                
                # Find the first .nc file inside the extracted directory
                nc_files = [os.path.join(dp, f) for dp, dn, filenames in os.walk(extract_dir) for f in filenames if f.endswith('.nc')]
                if not nc_files:
                    return jsonify({'error': 'El archivo ZIP no contiene ningún archivo .nc'}), 400
                filepath = nc_files[0] # Usar el primer .nc encontrado
                
            ds = xr.open_dataset(filepath)
            var_name = list(ds.data_vars)[0] 
            data_array = ds[var_name]

            dims_to_reduce = [d for d in data_array.dims if d in ['lat', 'lon', 'latitude', 'longitude']]
            series = data_array.mean(dim=dims_to_reduce) if dims_to_reduce else data_array

            resultados = procesar_serie(series)
            ds.close()

            # Record in Database History
            file_size_mb = os.path.getsize(filepath) / (1024 * 1024)
            new_record = DatasetHistory(
                user_id=current_user.id,
                filename=filename,
                size_mb=round(file_size_mb, 2),
                estado='Listo'
            )
            db.session.add(new_record)
            db.session.commit()

            return jsonify({
                'exito': True, 
                'variable': var_name,
                'filename': filename, 
                'datos': resultados,
                'tipo': 'Promedio de toda la zona',
                'record_fecha': new_record.fecha.strftime('%d %b %Y')
            })
        except Exception as e:
            current_app.logger.error(f"Error procesando NetCDF: {e}")
            return jsonify({'error': 'Error interno al procesar el archivo. Verifique el formato.'}), 500

@api_bp.route('/consultar_punto', methods=['POST'])
@login_required
def consultar_punto():
    data = request.json
    filename = secure_filename(data.get('filename'))
    try:
        lat, lon = float(data.get('lat')), float(data.get('lon'))
    except (TypeError, ValueError):
        return jsonify({'error': "Coordenadas inválidas"}), 400
    
    filepath = os.path.join(current_app.config['UPLOAD_FOLDER'], filename)
    try:
        ds = xr.open_dataset(filepath)
        var_name = list(ds.data_vars)[0]
        data_array = ds[var_name]

        lat_name = 'lat' if 'lat' in ds.coords else 'latitude' if 'latitude' in ds.coords else None
        lon_name = 'lon' if 'lon' in ds.coords else 'longitude' if 'longitude' in ds.coords else None

        if not lat_name or not lon_name:
            return jsonify({'error': "Coordenadas no encontradas en el dataset"}), 500

        lon_ajustada = lon + 360 if ds.coords[lon_name].max() > 180 and lon < 0 else lon
        punto = data_array.sel(**{lat_name: lat, lon_name: lon_ajustada, 'method': 'nearest'})
        resultados = procesar_serie(punto)
        ds.close()

        return jsonify({'exito': True, 'variable': var_name, 'datos': resultados, 'coords': f"Lat: {round(lat, 3)}, Lon: {round(lon, 3)}"})
    except Exception as e:
        current_app.logger.error(f"Error en consultar_punto: {e}")
        return jsonify({'error': 'Error consultando coordenadas en el dataset.'}), 500

@api_bp.route('/get_trends/<filename>')
@login_required
def get_trends(filename):
    filename = secure_filename(filename)
    filepath = os.path.join(current_app.config['UPLOAD_FOLDER'], filename)
    if not os.path.exists(filepath):
        return jsonify({'error': 'Archivo no encontrado'}), 404
    
    lat_val = request.args.get('lat', type=float)
    lon_val = request.args.get('lon', type=float)
    
    try:
        ds = xr.open_dataset(filepath)
        var_name = list(ds.data_vars)[0]
        data_array = ds[var_name]
        
        if lat_val is not None and lon_val is not None:
            sel_dict = {}
            if 'lat' in data_array.dims: sel_dict['lat'] = lat_val
            elif 'latitude' in data_array.dims: sel_dict['latitude'] = lat_val
            if 'lon' in data_array.dims: sel_dict['lon'] = lon_val
            elif 'longitude' in data_array.dims: sel_dict['longitude'] = lon_val
            series = data_array.sel(**sel_dict, method='nearest')
            ubicacion = f"Lat: {round(lat_val, 3)}, Lon: {round(lon_val, 3)}"
        else:
            dims_to_reduce = [d for d in data_array.dims if d in ['lat', 'lon', 'latitude', 'longitude']]
            series = data_array.mean(dim=dims_to_reduce) if dims_to_reduce else data_array
            ubicacion = "Resumen Regional"
        
        df = series.to_dataframe(name='valor').reset_index()
        df['fecha'] = pd.to_datetime(df['time'])
        df['mes'] = df['fecha'].dt.month
        df['anio'] = df['fecha'].dt.year
        
        anio_min = df['anio'].min()
        df = df[df['anio'] >= 1980]
        
        if df.empty:
            return jsonify({'exito': False, 'error': f'El archivo no contiene datos históricos válidos.'}), 400

        ciclo_raw = df.groupby('mes')['valor'].mean().round(2).to_dict()
        ciclo_final = [float(ciclo_raw.get(m, 0)) for m in range(1, 13)]
        
        anual_dist = {}
        for anio, g in df.groupby('anio'):
            m_raw = g.groupby('mes')['valor'].mean().round(2).to_dict()
            anual_dist[str(anio)] = [float(m_raw.get(m, 0)) for m in range(1, 13)]
        
        anual_raw = df.groupby('anio')['valor'].mean().round(2).sort_index().to_dict()
        anual_labels = [str(a) for a in anual_raw.keys()]
        anual_values = [float(v) for v in anual_raw.values()]
        
        promedio_total = float(df['valor'].mean())
        ultimo_anio = anual_values[-1] if anual_values else 0
        anomalia = ultimo_anio - promedio_total

        std_val = float(df['valor'].std())
        cv = std_val / promedio_total if promedio_total > 0 else 0
        estabilidad = "Alta" if cv < 0.25 else ("Moderada" if cv < 0.5 else "Baja")
        
        if anomalia > (0.15 * promedio_total):
            rec_text = "Se observa un excedente hídrico significativo. Se recomienda optimizar sistemas de drenaje."
        elif anomalia < (-0.15 * promedio_total):
            rec_text = "Déficit hídrico detectado respecto al histórico. Se sugiere priorizar el riego suplementario."
        else:
            rec_text = "Condiciones hídricas normales. Mantener prácticas culturales programadas."
        
        # New: Get Max Values for UI
        max_row = df.loc[df['valor'].idxmax()]
        max_precip = float(max_row['valor'])
        max_fecha = max_row['fecha'].strftime('%b %Y')

        ds.close()
        
        return jsonify({
            'exito': True,
            'ubicacion': ubicacion,
            'ciclo_labels': ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'],
            'ciclo_values': ciclo_final,
            'anual_dist': anual_dist,
            'anual_labels': anual_labels,
            'anual_values': anual_values,
            'promedio_total': round(promedio_total, 2),
            'anomalia': round(anomalia, 2),
            'max_precip': round(max_precip, 2),
            'max_fecha': max_fecha,
            'estabilidad': estabilidad,
            'recomendacion': rec_text
        })
    except Exception as e:
        if 'ds' in locals(): ds.close()
        current_app.logger.error(f"Error en tendencias API: {e}")
        return jsonify({'exito': False, 'error': 'Fallo en análisis de tendencias.'}), 500

@api_bp.route('/profile/update', methods=['POST'])
@login_required
def update_profile():
    data = request.json
    nombre = data.get('nombre')
    email = data.get('email')

    if email != current_user.email:
        if User.query.filter_by(email=email).first():
            return jsonify({'exito': False, 'error': 'El correo ya está en uso'}), 400
    
    current_user.nombre = nombre
    current_user.email = email
    db.session.commit()
    return jsonify({'exito': True})

@api_bp.route('/profile/password', methods=['POST'])
@login_required
def update_password():
    data = request.json
    current_pass = data.get('current_password')
    new_pass = data.get('new_password')

    if not check_password_hash(current_user.password, current_pass):
        return jsonify({'exito': False, 'error': 'La contraseña actual es incorrecta'}), 400

    current_user.password = generate_password_hash(new_pass, method='pbkdf2:sha256')
    db.session.commit()
    return jsonify({'exito': True})

@api_bp.route('/profile/2fa', methods=['POST'])
@login_required
def toggle_2fa():
    current_user.two_factor_enabled = not current_user.two_factor_enabled
    db.session.commit()
    return jsonify({'exito': True, 'two_factor_enabled': current_user.two_factor_enabled})

@api_bp.route('/profile/delete', methods=['DELETE'])
@login_required
def delete_account():
    user = User.query.get(current_user.id)
    DatasetHistory.query.filter_by(user_id=user.id).delete()
    db.session.delete(user)
    db.session.commit()
    logout_user()
    return jsonify({'exito': True})
