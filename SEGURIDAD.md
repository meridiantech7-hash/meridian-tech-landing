# MERIDIANTECH - PLAN DE SEGURIDAD

## 1. ARQUITECTURA SEGURA

Tu página es estática (HTML/CSS/JS), lo que significa:
- ✅ Sin base de datos expuesta
- ✅ Sin APIs vulnerables
- ✅ Sin credenciales de servidor en código
- ✅ Menor superficie de ataque

## 2. BLINDAJE ACTUAL

### En el HTML:
```html
<!-- Meta tags de seguridad agregados -->
<meta http-equiv="Content-Security-Policy" content="...">
<meta http-equiv="Referrer-Policy" content="...">
<meta http-equiv="Permissions-Policy" content="...">
```

**Qué hace:**
- CSP: Previene inyección de scripts maliciosos
- Referrer-Policy: Controla qué información se envía a terceros
- Permissions-Policy: Deshabilita acceso a cámara, micrófono, GPS, etc.

### En el servidor (.htaccess para Apache):
- X-Frame-Options: Previene que otros sitios hagan iframe de tu página
- X-Content-Type-Options: Previene interpretación incorrecta del contenido
- HSTS: Obliga HTTPS en futuras visitas
- Cache headers: Estrategia de cacheo óptima

---

## 3. CHECKLIST ANTES DE PUBLICAR

### ✅ Configuración del servidor

Si usas **Apache** (la mayoría de hosting):
```
1. Asegurate que existe el archivo .htaccess en la raiz
2. Verifica que mod_rewrite está habilitado
3. Verifica que mod_headers está habilitado
```

Si usas **NGINX**:
```
1. Copia la configuración de nginx-security.conf
2. Reemplaza paths en ssl_certificate y root
3. Recarga NGINX: sudo systemctl reload nginx
```

### ✅ HTTPS/SSL
- [ ] Obtener certificado SSL (Let's Encrypt es GRATUITO)
- [ ] Instalar certificado en el servidor
- [ ] Verificar que todo redirige a HTTPS
- [ ] Probar en: https://www.ssllabs.com/ssltest/

### ✅ Dominios y DNS
- [ ] Apuntar DNS a tu servidor
- [ ] Esperar propagación (max 24 horas)
- [ ] Verificar con: nslookup meridiantech.co

### ✅ Monitoreo
- [ ] Activar logs de acceso en el servidor
- [ ] Revisarlos regularmente buscando patrones sospechosos
- [ ] Configurar alertas si hay intentos de acceso a archivos sensibles

---

## 4. DATOS QUE NO TIENES EN RIESGO

✅ Información de clientes - No se recopila en el sitio
✅ Números de tarjeta - Solo van a WhatsApp, no al sitio
✅ Passwords - No hay autenticación en el sitio
✅ APIs keys - No existen en el código publicado

---

## 5. POTENCIALES ATAQUES Y DEFENSAS

### XSS (Cross-Site Scripting)
**Defensa:** CSP + validación en navegador
**Tu estado:** Seguro (no hay inputs de usuario)

### CSRF (Cross-Site Request Forgery)
**Defensa:** No aplica (es HTML estático)
**Tu estado:** Seguro

### Clickjacking
**Defensa:** X-Frame-Options: SAMEORIGIN
**Tu estado:** Protegido

### MITM (Man-in-the-Middle)
**Defensa:** HTTPS + HSTS
**Tu estado:** Protegido si configuras HTTPS

### DDoS
**Defensa:** Usar CDN (Cloudflare es gratis)
**Tu estado:** Evalúa según volumen esperado

---

## 6. ACCIONES POST-LANZAMIENTO

### Semana 1:
- Revisar logs de acceso
- Verificar que HTTPS funciona en todos los links
- Probar en diferentes navegadores y dispositivos

### Mensualmente:
- Revisar logs de acceso 2-3 veces
- Buscar patrones de ataque (400, 403, 404 en archivos .env, .git, etc)
- Verificar uptime

### Trimestralmente:
- Actualizar certificados SSL (automático si usas Let's Encrypt)
- Revisar cabeceras de seguridad en https://securityheaders.com/
- Auditoría de cambios no autorizados

---

## 7. ERRORES A EVITAR

❌ No poner credenciales en archivos HTML/JS
❌ No cargar librerías de CDNs desconocidos
❌ No tener comentarios con información sensible en HTML
❌ No servir HTTP sin redireccionar a HTTPS
❌ No confiar en validación del lado del cliente

---

## 8. HERRAMIENTAS DE VERIFICACIÓN

Usa estas herramientas GRATIS para auditar tu seguridad:

1. **SSL/TLS:** https://www.ssllabs.com/ssltest/
2. **Headers de seguridad:** https://securityheaders.com/
3. **Inyección XSS:** Abrir DevTools > Console y probar scripts
4. **Logs:** Revisar access.log en tu servidor

---

## 9. CONTACTO Y ACTUALIZACIONES

Si detectas algo sospechoso:
1. Revisa los logs del servidor
2. Contacta a tu hosting provider
3. Ten un backup reciente

Los números de WhatsApp (+57 314 216 2323) están al alcance del cliente, no en riesgo. 
Los enlaces a redes sociales son públicos.

---

## 10. CONCLUSIÓN

Tu sitio es **relativamente seguro por diseño** (es estático).
El .htaccess proporciona defensa adicional contra ataques comunes.
HTTPS es lo único CRÍTICO antes de publicar.

