/* SAM-Magangué · página de inicio: regla limnimétrica animada y acceso de demostración */
(function(){
  "use strict";
  /* ---------- Regla limnimétrica (6,0 a 11,0 m) ---------- */
  var MIN=6,MAX=11,Y0=360,Y1=20; // y para MIN y MAX
  var Y=function(h){return Y0-(h-MIN)*(Y0-Y1)/(MAX-MIN)};
  var NS="http://www.w3.org/2000/svg";
  function el(tag,attrs,txt){var e=document.createElementNS(NS,tag);for(var k in attrs)e.setAttribute(k,attrs[k]);if(txt)e.textContent=txt;return e}
  var marcas=document.getElementById("marcas"),umb=document.getElementById("umbrales");
  for(var c=60;c<=110;c+=2){var h=c/10,y=Y(h),mayor=c%10===0;
    marcas.appendChild(el("line",{x1:120,x2:mayor?162:140,y1:y,y2:y,stroke:"var(--tinta-fija)","stroke-width":mayor?2.2:1.2}));
    if(mayor)marcas.appendChild(el("text",{x:150,y:y-4,"font-size":"12","font-family":"IBM Plex Mono, monospace",fill:"var(--tinta-fija)","text-anchor":"middle"},String(h)));}
  [[8,"amarilla","Amarilla 8 m"],[9,"naranja","Naranja 9 m"],[10,"roja","Roja 10 m"]].forEach(function(u){var y=Y(u[0]);
    umb.appendChild(el("line",{x1:20,x2:300,y1:y,y2:y,stroke:"var(--"+u[1]+")","stroke-width":1.5,"stroke-dasharray":"6 5"}));
    umb.appendChild(el("text",{x:190,y:y-6,"font-size":"12","font-family":"IBM Plex Mono, monospace",fill:"var(--"+u[1]+")"},u[2]));});

  // Serie del escenario "creciente" (misma forma que el simulador): tasas por tramo en m/h
  var tramos=[[12,0.02],[48,0.06],[60,0.03],[72,-0.02]];
  function nivel(t){var h=7.4,prev=0;for(var i=0;i<tramos.length;i++){var fin=tramos[i][0],dt=Math.min(t,fin)-prev;if(dt<=0)break;h+=dt*tramos[i][1];prev=fin}return h}
  function tasa(t){for(var i=0;i<tramos.length;i++)if(t<=tramos[i][0])return tramos[i][1];return 0}
  var fmt=function(x,d){return x.toFixed(d).replace(".",",")};
  var ola=document.getElementById("ola"),lh=document.getElementById("lec-h"),lv=document.getElementById("lec-v"),lt=document.getElementById("lec-t"),est=document.getElementById("lec-estado");
  var reducir=window.matchMedia&&matchMedia("(prefers-reduced-motion: reduce)").matches;
  var t=30,fase=0;
  function estado(h,v){var U=[8,9,10],n=0;for(var k=0;k<3;k++){var tu=h>=U[k]?0:(v>0?(U[k]-h)/v:Infinity);if(h>=U[k]||tu<=6)n=k+1}return n}
  var NOM=[["verde","Normal"],["amarilla","Alerta amarilla"],["naranja","Alerta naranja"],["roja","Alerta roja"]];
  function pintar(){
    var h=nivel(t),v=tasa(t),y=Y(h),d="M0,"+y;
    for(var x=0;x<=320;x+=16)d+=" L"+x+","+(y+Math.sin(x/28+fase)*3.2).toFixed(1);
    ola.setAttribute("d",d+" L320,380 L0,380 Z");
    lh.textContent=fmt(h,2)+" m";lv.textContent=(v>=0?"+":"")+fmt(v,2)+" m/h";
    lt.textContent=h>=10?"superado":(v>0?fmt((10-h)/v,1)+" h":"no se acerca");
    var n=estado(h,v);est.className="chip "+NOM[n][0];est.textContent=NOM[n][1];
  }
  pintar();
  if(!reducir){var ult=0;requestAnimationFrame(function paso(ts){if(ts-ult>40){fase+=.18;t+=0.035;if(t>66)t=20;pintar();ult=ts}requestAnimationFrame(paso)})}

  /* ---------- Acceso de demostración ---------- */
  var DEMO={usuario:"demo123",clave:"demo1234"};
  function usuarios(){try{return JSON.parse(localStorage.getItem("sam_usuarios")||"{}")}catch(e){return {}}}
  function guardar(obj,clave){try{localStorage.setItem(clave,JSON.stringify(obj));return true}catch(e){return false}}
  var dlg=document.getElementById("auth"),fl=document.getElementById("f-login"),fr=document.getElementById("f-registro");
  function vista(v){var reg=v==="registro";fl.hidden=reg;fr.hidden=!reg;
    document.getElementById("tab-login").setAttribute("aria-selected",String(!reg));
    document.getElementById("tab-registro").setAttribute("aria-selected",String(reg));
    setTimeout(function(){(reg?document.getElementById("r-nombre"):document.getElementById("l-usuario")).focus()},30)}
  function abrir(v){vista(v);if(typeof dlg.showModal==="function"){if(!dlg.open)dlg.showModal()}else dlg.setAttribute("open","")}
  document.querySelectorAll("[data-abrir]").forEach(function(b){b.addEventListener("click",function(){abrir(b.getAttribute("data-abrir"))})});
  document.querySelectorAll("[data-vista]").forEach(function(b){b.addEventListener("click",function(){vista(b.getAttribute("data-vista"))})});
  function error(id,msg){var e=document.getElementById(id);e.textContent=msg;e.hidden=!msg}
  function entrar(sesion){if(!guardar(sesion,"sam_sesion")){error("l-error","El navegador bloqueó el almacenamiento local; abra la página en una ventana normal.");return}location.href="app.html"}

  document.getElementById("usar-demo").addEventListener("click",function(){document.getElementById("l-usuario").value=DEMO.usuario;document.getElementById("l-clave").value=DEMO.clave});
  fl.addEventListener("submit",function(e){e.preventDefault();
    var u=document.getElementById("l-usuario").value.trim().toLowerCase(),p=document.getElementById("l-clave").value;
    if(!u||!p)return error("l-error","Escriba el usuario y la contraseña.");
    if(u===DEMO.usuario&&p===DEMO.clave)return entrar({usuario:"demo123",nombre:"Operador CMGRD (demo)",rol:"Operador",barrio:"gir",canal:"push"});
    var x=usuarios()[u];
    if(!x||x.clave!==p)return error("l-error","Usuario o contraseña incorrectos. Pruebe la cuenta demo o regístrese.");
    entrar({usuario:x.usuario,nombre:x.nombre,rol:x.rol,barrio:x.barrio,canal:x.canal});
  });
  fr.addEventListener("submit",function(e){e.preventDefault();
    var nombre=document.getElementById("r-nombre").value.trim(),u=document.getElementById("r-usuario").value.trim().toLowerCase(),p=document.getElementById("r-clave").value;
    if(nombre.length<3)return error("r-error","Escriba su nombre completo.");
    if(!/^[a-z0-9._-]{4,}$/.test(u))return error("r-error","El usuario debe tener al menos 4 caracteres, sin espacios.");
    if(u===DEMO.usuario||usuarios()[u])return error("r-error","Ese usuario ya existe. Elija otro.");
    if(p.length<6)return error("r-error","La contraseña debe tener al menos 6 caracteres.");
    if(!document.getElementById("r-acepto").checked)return error("r-error","Debe autorizar el tratamiento de datos para recibir alertas.");
    var todos=usuarios(),nuevo={usuario:u,clave:p,nombre:nombre,rol:"Ciudadano",barrio:document.getElementById("r-barrio").value,canal:document.getElementById("r-canal").value};
    todos[u]=nuevo;if(!guardar(todos,"sam_usuarios"))return error("r-error","El navegador bloqueó el almacenamiento local.");
    entrar({usuario:u,nombre:nombre,rol:"Ciudadano",barrio:nuevo.barrio,canal:nuevo.canal});
  });
  if(location.hash==="#registro"||location.hash==="#login")abrir(location.hash.slice(1));
})();
