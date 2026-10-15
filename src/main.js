import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const stage = document.querySelector('#stage');
const status = document.querySelector('#status');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const state = { pressure: .58, tension: .65, roughness: .23, damping: 12, influence: 150, lightRotation: -25, lightBrightness: 1, displayGlow: 1.6, displaySoftness: .5, glow: .75, reflection: 2, pearl: .55, refraction: .08, membraneColor: '#b8a6a2', pearlColorA: '#a6e7ff', pearlColorB: '#f4b9e4', night: false, breath: !reducedMotion.matches, showModel: false };
const pointer = new THREE.Vector2();
let renderer, model, membrane, contactTarget, targets, simulationMaterial, shader;
let opticalRoot, emitterShape, contactHalfDepth=.78;
const displayUniforms={displayMap:{value:null},displayGlow:{value:1.6},displaySoftness:{value:.5},sphereInverse:{value:new THREE.Matrix4()}};
let composer, renderPass, bloomPass, studioEnvironment, studioTarget, lightingTimer;
const studioLights = [], modelMaterials = new Map();
const contactLight = new THREE.PointLight('#d9eaff',0,5,2);
let size = new THREE.Vector2(), resolution = new THREE.Vector2(), current = 0;
let resetSimulation = false, disposed = false, ready = false, accumulator = 0, elapsed = 0, frameCount = 0;
const resources = [];
const keep = resource => (resources.push(resource), resource);
// A luminous decal in sphere-local coordinates; it rotates with the model.
const displayGLSL=`
  uniform sampler2D displayMap;
  uniform float displayGlow,displaySoftness;
  uniform mat4 sphereInverse;
  vec3 displayEmission(vec3 localPoint,float blurRadius) {
    vec2 displayUV=localPoint.xy/vec2(1.2,.66)+.5;
    float front=smoothstep(.45,.7,localPoint.z);
    float inside=step(0.,displayUV.x)*step(displayUV.x,1.)*step(0.,displayUV.y)*step(displayUV.y,1.);
    vec2 dx=vec2(blurRadius,0.),dy=vec2(0.,blurRadius);
    vec3 light=texture2D(displayMap,displayUV).rgb*.4;
    light+=(texture2D(displayMap,displayUV+dx).rgb+texture2D(displayMap,displayUV-dx).rgb+texture2D(displayMap,displayUV+dy).rgb+texture2D(displayMap,displayUV-dy).rgb)*.15;
    return light*front*inside*displayGlow;
  }
`;
let displayClock;
function updateDisplayClock(now) {
  if(!displayClock||now-displayClock.lastCheck<1000)return;
  displayClock.lastCheck=now;
  const date=new Date();
  const text=String(date.getHours()).padStart(2,'0')+':'+String(date.getMinutes()).padStart(2,'0');
  if(text===displayClock.text)return;
  displayClock.text=text;
  const ctx=displayClock.ctx;
  ctx.fillStyle='#000000';ctx.fillRect(0,0,1024,512);
  ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.font='500 260px "Bitcount Single"';
  ctx.shadowColor='#b9ffd7';ctx.shadowBlur=12;ctx.fillStyle='#b9ffd7';
  ctx.fillText(text,512,256);
  displayClock.texture.needsUpdate=true;
}
function createDisplayTexture() {
  const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=512;
  const texture=keep(new THREE.CanvasTexture(canvas));
  texture.colorSpace=THREE.SRGBColorSpace;
  displayClock={ctx:canvas.getContext('2d'),texture,text:null,lastCheck:-Infinity};
  updateDisplayClock(0);
  return texture;
}
const scene = new THREE.Scene();
scene.add(contactLight);
const camera = new THREE.PerspectiveCamera(35,1,.1,30);
const contactScene = new THREE.Scene();
const modelRoot = new THREE.Group();
contactScene.add(modelRoot);
const contactCamera = new THREE.OrthographicCamera(-1,1,1,-1,.01,20);
contactCamera.position.z = 5;
const simulationScene = new THREE.Scene();
const simulationCamera = new THREE.OrthographicCamera(-1,1,1,-1,0,2);
simulationCamera.position.z = 1;
const quad = new THREE.Mesh(keep(new THREE.PlaneGeometry(2,2)));
simulationScene.add(quad);

const vertex = `varying vec2 vUv; void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}`;
const contactMaterial = keep(new THREE.ShaderMaterial({
  vertexShader: `varying vec3 world;void main(){world=(modelMatrix*vec4(position,1.)).xyz;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
  fragmentShader: `varying vec3 world;void main(){gl_FragColor=vec4(world,1.);}`,
  toneMapped: false
}));
const initMaterial = keep(new THREE.ShaderMaterial({ vertexShader:vertex, fragmentShader:'void main(){gl_FragColor=vec4(0.,0.,0.,1.);}',depthTest:false,depthWrite:false,toneMapped:false }));

function createTarget(w,h,depth=false,type=THREE.HalfFloatType) {
  return new THREE.WebGLRenderTarget(w,h,{ type, format:THREE.RGBAFormat, minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,depthBuffer:depth,stencilBuffer:false });
}

function pass(material,target) {
  quad.material = material;
  renderer.setRenderTarget(target);
  renderer.render(simulationScene,simulationCamera);
}

function initSimulation() {
  for(const target of targets) pass(initMaterial,target);
  current=0;
  accumulator=0;
  resetSimulation=false;
}

function resize() {
  const width=stage.clientWidth, height=stage.clientHeight;
  renderer.setSize(width,height);
  composer?.setSize(width,height);
  camera.aspect=width/height;
  camera.position.z=5.2;
  camera.updateProjectionMatrix();
  const viewHeight=2*camera.position.z*Math.tan(THREE.MathUtils.degToRad(camera.fov/2));
  size.set(viewHeight*camera.aspect*1.1,viewHeight*1.1);
  const shortSide=128;
  const scale=shortSide/Math.min(size.x,size.y);
  resolution.set(Math.min(320,Math.round(size.x*scale)),Math.min(320,Math.round(size.y*scale)));
  contactCamera.left=-size.x/2;contactCamera.right=size.x/2;
  contactCamera.top=size.y/2;contactCamera.bottom=-size.y/2;
  contactCamera.updateProjectionMatrix();
  contactTarget?.dispose(); targets?.forEach(t=>t.dispose());
  // Contact/emission edges need screen-level detail, independently of physics.
  const contactScale=renderer.getPixelRatio()*1.5;
  contactTarget=createTarget(Math.min(2048,Math.ceil(width*contactScale)),Math.min(2048,Math.ceil(height*contactScale)),true);
  contactTarget.samples=Math.min(4,renderer.capabilities.maxSamples);
  contactTarget.texture.minFilter=THREE.LinearFilter;
  contactTarget.texture.magFilter=THREE.LinearFilter;
  // Float32 avoids half-float height terraces that shimmer in thin specular ridges.
  // The solver reads exact texel centers; the visible sheet reconstructs smoothly.
  targets=[createTarget(resolution.x,resolution.y,false,THREE.FloatType),createTarget(resolution.x,resolution.y,false,THREE.FloatType)];
  simulationMaterial.uniforms.contact.value=contactTarget.texture;
  simulationMaterial.uniforms.px.value.set(1/resolution.x,1/resolution.y);
  membrane.geometry.dispose();
  const geometry=new THREE.PlaneGeometry(size.x,size.y,resolution.x*2-1,resolution.y*2-1);
  const uvs=geometry.attributes.uv;
  for(let i=0;i<uvs.count;i++) {
    uvs.setXY(i,(uvs.getX(i)*(resolution.x-1)+.5)/resolution.x,(uvs.getY(i)*(resolution.y-1)+.5)/resolution.y);
  }
  membrane.geometry=geometry;
  if(shader) { shader.uniforms.sheetSize.value.copy(size);shader.uniforms.sheetPx.value.set(1/resolution.x,1/resolution.y);shader.uniforms.sheetContact.value=contactTarget.texture; }
  initSimulation();
}

function updateContact(dt) {
  const blend=reducedMotion.matches?1:1-Math.exp(-4*dt);
  const amplitude=Math.min(size.x*.18,.65);
  modelRoot.position.x=THREE.MathUtils.lerp(modelRoot.position.x,pointer.x*amplitude,blend);
  modelRoot.position.y=THREE.MathUtils.lerp(modelRoot.position.y,pointer.y*.45,blend);
  const breath=state.breath&&!reducedMotion.matches?Math.sin(elapsed*Math.PI*2/5)*.055:0;
  modelRoot.position.z=THREE.MathUtils.lerp(modelRoot.position.z,state.pressure-contactHalfDepth+breath,blend);
  modelRoot.rotation.y=THREE.MathUtils.lerp(modelRoot.rotation.y,pointer.x*.55,blend);
  modelRoot.rotation.x=THREE.MathUtils.lerp(modelRoot.rotation.x,-pointer.y*.35,blend);
  modelRoot.updateMatrixWorld(true);
  if(emitterShape)displayUniforms.sphereInverse.value.copy(emitterShape.matrixWorld).invert();
  if(opticalRoot) {
    opticalRoot.position.copy(modelRoot.position);opticalRoot.position.z-=.26;
    opticalRoot.quaternion.copy(modelRoot.quaternion);
    opticalRoot.updateMatrixWorld(true);
  }
  contactLight.position.set(modelRoot.position.x-.65,modelRoot.position.y+.45,.38);
  contactScene.overrideMaterial=contactMaterial;
  renderer.setRenderTarget(contactTarget);
  renderer.setClearColor(0,0);renderer.clear();
  renderer.render(contactScene,contactCamera);
  contactScene.overrideMaterial=null;
}

function tick(dt) {
  simulationMaterial.uniforms.tension.value=state.tension;
  simulationMaterial.uniforms.damping.value=state.damping;
  simulationMaterial.uniforms.influence.value=state.influence;
  simulationMaterial.uniforms.positions.value=targets[current].texture;
  simulationMaterial.uniforms.dt.value=dt;
  pass(simulationMaterial,targets[1-current]);
  current=1-current;
}

function animate(now) {
  if(disposed)return;
  const delta=Math.min((now-lastTime)/1000,.05);lastTime=now;
  if(!document.hidden && ready) {
    updateDisplayClock(now);
    elapsed+=delta;
    updateContact(delta);
    if(resetSimulation)initSimulation();
    accumulator+=delta;
    let steps=0;
    while(accumulator>=1/120&&steps<6) {tick(1/120);accumulator-=1/120;steps++;}
    if(shader) {
      shader.uniforms.sheetPositions.value=targets[current].texture;
      shader.uniforms.nightMode.value=state.night?1:0;
      shader.uniforms.contactGlow.value=state.glow;
      shader.uniforms.waveReflection.value=state.reflection;
      shader.uniforms.pearlStrength.value=state.pearl;
      shader.uniforms.contactCenter.value.copy(modelRoot.position);
    }
    renderer.setRenderTarget(null);
    renderer.setClearColor(state.night?'#03050a':'#b8a6a2',1);
    membrane.visible=!state.showModel;
    if(state.night) {
      renderPass.scene=state.showModel?contactScene:scene;
      composer.render();
    } else renderer.render(state.showModel?contactScene:scene,camera);
    frameCount++;
    if(now-metricsTime>1000) {
      const fps=Math.round(frameCount*1000/(now-metricsTime));
      status.textContent=`${state.showModel?'Исходная форма':'Мембрана'} · ${fps} fps`;
      frameCount=0;metricsTime=now;
    }
  }
  raf=requestAnimationFrame(animate);
}

const onPointer = event => {
  const rect=stage.getBoundingClientRect();
  pointer.set((event.clientX-rect.left)/rect.width*2-1,1-(event.clientY-rect.top)/rect.height*2);
};
const onLeave=()=>pointer.set(0,0);
stage.addEventListener('pointermove',onPointer);
stage.addEventListener('pointerleave',onLeave);

const toggle=document.querySelector('#toggle'),controls=document.querySelector('#controls');
toggle.addEventListener('click',()=>{controls.hidden=!controls.hidden;toggle.setAttribute('aria-expanded',String(!controls.hidden));toggle.querySelector('span').textContent=controls.hidden?'+':'−';});
for(const name of ['pressure','tension','roughness','damping','influence','glow','reflection','pearl','refraction','displayGlow','displaySoftness','lightRotation','lightBrightness']) {
  document.querySelector('#'+name).addEventListener('input',event=>{
    state[name]=Number(event.target.value);
    if(name==='lightBrightness') {
      clearTimeout(lightingTimer);
      lightingTimer=setTimeout(()=>{if(!disposed&&renderer){updateStudioEnvironment();applyTheme();}},80);
    }
    if(name in displayUniforms)displayUniforms[name].value=state[name];
    document.querySelector('#'+name+'Value').textContent=state[name].toFixed(2);
    if(name==='roughness'&&membrane)membrane.material.roughness=state.roughness;
    if(['glow','pearl','refraction','lightRotation','lightBrightness'].includes(name))applyTheme();
  });
}
document.querySelector('#breath').addEventListener('click',event=>{state.breath=!state.breath;event.target.setAttribute('aria-pressed',String(state.breath));event.target.textContent='Дыхание: '+(state.breath?'вкл':'выкл');});
document.querySelector('#view').addEventListener('click',event=>{state.showModel=!state.showModel;event.target.setAttribute('aria-pressed',String(state.showModel));event.target.textContent=state.showModel?'Показать мембрану':'Показать форму';});
document.querySelector('#reset').addEventListener('click',()=>{resetSimulation=true;pointer.set(0,0);});
function bindColorControl(key,hexId) {
  const picker=document.querySelector('#'+key);
  const hex=document.querySelector('#'+hexId);
  const update=value=>{
    if(!/^#[0-9a-f]{6}$/i.test(value))return;
    state[key]=value.toLowerCase();
    picker.value=state[key];
    hex.value=state[key].toUpperCase();
    applyTheme();
  };
  picker.addEventListener('input',event=>update(event.target.value));
  hex.addEventListener('input',event=>update(event.target.value));
  hex.addEventListener('blur',()=>{hex.value=state[key].toUpperCase();});
}
bindColorControl('membraneColor','membraneHex');
bindColorControl('pearlColorA','pearlHexA');
bindColorControl('pearlColorB','pearlHexB');

function updateStudioEnvironment() {
  // One broad softbox in an HDR panorama replaces the multi-source studio room.
  const width=512,height=256,pixels=new Float32Array(width*height*4);
  const source=new THREE.Vector3(-.55,.55,.8).normalize();
  const right=new THREE.Vector3().crossVectors(source,new THREE.Vector3(0,1,0)).normalize();
  const up=new THREE.Vector3().crossVectors(right,source).normalize();
  const direction=new THREE.Vector3();
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    const theta=Math.PI*(y+.5)/height,phi=2*Math.PI*(x+.5)/width;
    direction.set(-Math.sin(theta)*Math.cos(phi),-Math.cos(theta),-Math.sin(theta)*Math.sin(phi));
    const forward=direction.dot(source);
    const horizontal=direction.dot(right),vertical=direction.dot(up);
    const softbox=forward>0?4.5*Math.exp(-Math.pow(horizontal/.32,4)-Math.pow(vertical/.58,4)):0;
    const ambient=(.95+.45*Math.max(direction.y,0))*state.lightBrightness;
    const offset=(y*width+x)*4;
    pixels[offset]=ambient+softbox;
    pixels[offset+1]=ambient+softbox*.98;
    pixels[offset+2]=ambient+softbox*.95;
    pixels[offset+3]=1;
  }
  const panorama=new THREE.DataTexture(pixels,width,height,THREE.RGBAFormat,THREE.FloatType);
  panorama.mapping=THREE.EquirectangularReflectionMapping;
  panorama.needsUpdate=true;
  const envGenerator=new THREE.PMREMGenerator(renderer);
  const env=keep(envGenerator.fromEquirectangular(panorama));
  if(studioTarget) {
    studioTarget.dispose();
    const index=resources.indexOf(studioTarget);
    if(index!==-1)resources.splice(index,1);
  }
  studioTarget=env;
  panorama.dispose();
  studioEnvironment=env.texture;
  scene.environment=env.texture;contactScene.environment=env.texture;
  envGenerator.dispose();
}

function applyTheme() {
  // Night rendering is temporarily disabled for the published prototype.
  state.night=false;
  document.body.classList.toggle('night',state.night);
  document.querySelector('meta[name="theme-color"]').content=state.night?'#03050a':'#b8a6a2';
  if(!membrane)return;
  scene.environment=contactScene.environment=state.night?null:studioEnvironment;
  const lightAngle=THREE.MathUtils.degToRad(state.lightRotation);
  scene.environmentRotation.set(0,lightAngle,0);
  contactScene.environmentRotation.set(0,lightAngle,0);
  for(const light of studioLights) {
    light.visible=!state.night;
    light.intensity=light.userData.dayIntensity*state.lightBrightness;
  }
  contactLight.intensity=state.night?state.glow*.6:0;
  membrane.material.color.set(state.membraneColor);
  if(state.night)membrane.material.color.multiplyScalar(.18);
  if(shader) {
    shader.uniforms.pearlA.value.set(state.pearlColorA);
    shader.uniforms.pearlB.value.set(state.pearlColorB);
  }
  membrane.material.metalness=state.night ? .3 : .45;
  membrane.material.iridescence=state.pearl;
  membrane.material.transmission=state.refraction;
  // Beer-Lambert absorption tints transmitted light, not the diffuse fabric.
  membrane.material.attenuationColor.set('#ffffff');
  membrane.material.attenuationDistance=.08;
  if(opticalRoot)opticalRoot.visible=state.refraction>0;
  for(const [material,original] of modelMaterials) {
    material.emissive?.copy(state.night?new THREE.Color('#bfdfff'):original.emissive);
    if('emissiveIntensity' in material)material.emissiveIntensity=state.night?state.glow*1.2:original.intensity;
  }
}

let lastTime=performance.now(),metricsTime=lastTime,raf;

async function start() {
  const clockFont=new FontFace('Bitcount Single','url(./fonts/BitcountSingle-Medium.ttf)',{weight:'500',style:'normal'});
  document.fonts.add(await clockFont.load());
  displayUniforms.displayMap.value=createDisplayTexture();
  renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:'high-performance'});
  renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));
  renderer.outputColorSpace=THREE.SRGBColorSpace;
  renderer.toneMapping=THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure=.95;
  renderer.transmissionResolutionScale=.5;
  stage.appendChild(renderer.domElement);
  if(!renderer.extensions.has('EXT_color_buffer_float'))throw new Error('Для мембраны нужны float-буферы WebGL2.');
  simulationMaterial=keep(new THREE.ShaderMaterial({
    uniforms:{positions:{value:null},contact:{value:null},px:{value:new THREE.Vector2()},dt:{value:1/120},tension:{value:state.tension},damping:{value:state.damping},influence:{value:state.influence}},
    vertexShader:vertex,
    fragmentShader:`
      varying vec2 vUv;
      uniform sampler2D positions,contact;
      uniform vec2 px;
      uniform float dt,tension,damping,influence;
      void main(){
        vec2 hv=texture2D(positions,vUv).rg;
        float lap=texture2D(positions,vUv+vec2(px.x,0.)).r+texture2D(positions,vUv-vec2(px.x,0.)).r
          +texture2D(positions,vUv+vec2(0.,px.y)).r+texture2D(positions,vUv-vec2(0.,px.y)).r-4.*hv.x;
        vec4 form=texture2D(contact,vUv);
        float target=max(form.z,0.)*form.a;
        float force=lap*mix(150.,1450.,tension)-hv.x*12.+max(target-hv.x,0.)*influence;
        float velocity=(hv.y+force*dt)*exp(-damping*dt);
        float height=max(hv.x+velocity*dt,0.);
        float edge=min(min(vUv.x,1.-vUv.x),min(vUv.y,1.-vUv.y));
        float pin=smoothstep(0.,.045,edge);
        gl_FragColor=vec4(height*pin,velocity*pin,0.,1.);
      }`,depthTest:false,depthWrite:false,toneMapped:false
  }));
  const material=keep(new THREE.MeshPhysicalMaterial({color:'#b8a6a2',metalness:.45,roughness:state.roughness,clearcoat:.85,clearcoatRoughness:.24,envMapIntensity:.85,iridescence:state.pearl,iridescenceIOR:1.34,iridescenceThicknessRange:[260,380],transmission:state.refraction,ior:1.34,thickness:.08}));
  material.onBeforeCompile=program=>{
    shader=program;
    Object.assign(program.uniforms,displayUniforms);
    Object.assign(program.uniforms,{sheetPositions:{value:targets[current].texture},sheetPx:{value:new THREE.Vector2(1/resolution.x,1/resolution.y)},sheetSize:{value:size.clone()},sheetContact:{value:contactTarget.texture},nightMode:{value:state.night?1:0},contactGlow:{value:state.glow},waveReflection:{value:state.reflection},pearlStrength:{value:state.pearl},pearlA:{value:new THREE.Color(state.pearlColorA)},pearlB:{value:new THREE.Color(state.pearlColorB)},contactCenter:{value:modelRoot.position.clone()}});
    program.vertexShader=`
      uniform sampler2D sheetPositions;
      uniform vec2 sheetPx,sheetSize;
      varying vec3 sheetPosition;
      vec4 sheetWeights(float t) {
        float t2=t*t,t3=t2*t;
        return vec4(1.-3.*t+3.*t2-t3,4.-6.*t2+3.*t3,1.+3.*t+3.*t2-3.*t3,t3)/6.;
      }
      vec4 sheetDerivatives(float t) {
        float t2=t*t;
        return vec4(-3.+6.*t-3.*t2,-12.*t+9.*t2,3.+6.*t-9.*t2,3.*t2)/6.;
      }
      // One positive cubic B-spline reconstructs both height and its derivatives.
      // It is render-only: no smoothing feeds back into the physical simulation.
      vec3 reconstructSheet(vec2 coord) {
        vec2 grid=coord/sheetPx-.5;
        vec2 base=floor(grid),f=fract(grid);
        vec4 wx=sheetWeights(f.x),wy=sheetWeights(f.y);
        vec4 dx=sheetDerivatives(f.x),dy=sheetDerivatives(f.y);
        vec3 result=vec3(0.);
        for(int y=0;y<4;y++)for(int x=0;x<4;x++) {
          vec2 sampleUV=(base+vec2(float(x-1),float(y-1))+.5)*sheetPx;
          float h=texture2D(sheetPositions,sampleUV).r;
          result+=h*vec3(wx[x]*wy[y],dx[x]*wy[y],wx[x]*dy[y]);
        }
        result.yz*=(1./sheetPx-1.)/sheetSize;
        return result;
      }
    `+program.vertexShader;
    program.vertexShader=program.vertexShader.replace('#include <beginnormal_vertex>',`
      vec3 sheetSample=reconstructSheet(uv);
      vec3 objectNormal=normalize(vec3(-sheetSample.y,-sheetSample.z,1.));
      #ifdef USE_TANGENT
        vec3 objectTangent=vec3(tangent.xyz);
      #endif
    `).replace('#include <begin_vertex>','vec3 transformed=vec3(position.xy,sheetSample.x);sheetPosition=transformed;');
    program.fragmentShader=displayGLSL+`uniform sampler2D sheetContact;uniform vec2 sheetSize;uniform vec3 contactCenter,pearlA,pearlB;uniform float nightMode,contactGlow,waveReflection,pearlStrength;varying vec3 sheetPosition;\n`+program.fragmentShader;
    program.fragmentShader=program.fragmentShader.replace('#include <emissivemap_fragment>',`
      #include <emissivemap_fragment>
      vec4 contactForm=texture2D(sheetContact,sheetPosition.xy/sheetSize+.5);
      float maskAA=max(fwidth(contactForm.a),.025);
      float contactMask=smoothstep(.5-maskAA,.5+maskAA,contactForm.a)*smoothstep(.005,.06,contactForm.z);
      vec2 haloOffset=sheetPosition.xy-contactCenter.xy;
      float scatteredGlow=.018*exp(-dot(haloOffset,haloOffset)/2.4);
      // Transfer surface emission through the cloth with local scattering.
      // World-space contact reconstructs the sphere decal under a curved membrane.
      vec3 displayPoint=(sphereInverse*vec4(contactForm.xyz,1.)).xyz;
      float membraneGap=max(sheetPosition.z-contactForm.z,0.);
      float displayBlur=.002+displaySoftness*.018+min(membraneGap,.15)*.06;
      vec3 transmittedDisplay=displayEmission(displayPoint,displayBlur);
      transmittedDisplay*=contactMask*exp(-membraneGap*7.);
      totalEmissiveRadiance+=transmittedDisplay;
      // Soft scattering follows the curved surface instead of flattening its shading.
      float contactFacing=clamp(abs(dot(normalize(normal),normalize(vViewPosition))),0.,1.);
      float contactRim=pow(1.-contactFacing,2.);
      float softContact=.35+.95*contactRim+.22*clamp(contactForm.z,0.,1.);
      totalEmissiveRadiance+=vec3(.62,.8,1.)*(contactMask*softContact*1.8+scatteredGlow)*contactGlow*nightMode;
      // Four samples approximate the broad emissive contact as an area source.
      // This is local direct lighting, not global illumination or a painted ripple.
      vec3 reflectedContactLight=vec3(0.);
      // Enhance small simulated slopes outside the contact without adding waves.
      vec3 clothNormal=normalize(vec3(normal.xy*mix(6.,1.,contactMask),normal.z));
      vec3 eyeDirection=normalize(vViewPosition);
      // Thin-film interference tint for the custom contact-light approximation.
      // The built-in physical material handles iridescence for ordinary lights.
      float filmCos=max(dot(clothNormal,eyeDirection),0.);
      float paletteAngle=clamp(abs(dot(normalize(normal),eyeDirection)),0.,1.);
      float paletteBlend=.5+.5*cos(6.2831853*(1.8*(1.-paletteAngle)+.15));
      vec3 pearlPalette=mix(pearlA,pearlB,paletteBlend);
      vec3 pearlTint=mix(vec3(.26,.51,1.),pearlPalette,pearlStrength);
      for(int sampleIndex=0;sampleIndex<4;sampleIndex++) {
        float sx=sampleIndex<2?-.58:.58;
        float sy=(sampleIndex==0||sampleIndex==2)?-.42:.42;
        vec3 emitter=vec3(contactCenter.xy+vec2(sx,sy),.38);
        vec3 toEmitter=emitter-sheetPosition;
        float lightDistance=length(toEmitter);
        vec3 lightDirection=toEmitter/max(lightDistance,.001);
        vec3 halfDirection=normalize(lightDirection+eyeDirection);
        float diffuseResponse=max(dot(clothNormal,lightDirection),0.);
        float specularResponse=pow(max(dot(clothNormal,halfDirection),0.),mix(6.,30.,1.-roughness));
        float falloff=1./(1.+.65*lightDistance*lightDistance);
        float slope=clamp(length(clothNormal.xy)*2.,0.,1.);
        reflectedContactLight+=pearlTint*(diffuseResponse*(.25+.65*slope)+specularResponse*.6)*falloff*.25;
      }
      reflectedContactLight*=contactGlow*waveReflection*nightMode*(1.-contactMask*.8);
    `);
    // Artistic palette tint for physical specular and clearcoat highlights.
    program.fragmentShader=program.fragmentShader.replace('vec3 totalSpecular = reflectedLight.directSpecular + reflectedLight.indirectSpecular;','vec3 totalSpecular = (reflectedLight.directSpecular + reflectedLight.indirectSpecular) * mix(vec3(1.),pearlPalette,pearlStrength);');
    program.fragmentShader=program.fragmentShader.replace('( clearcoatSpecularDirect + clearcoatSpecularIndirect ) * material.clearcoat','( clearcoatSpecularDirect + clearcoatSpecularIndirect ) * mix(vec3(1.),pearlPalette,pearlStrength) * material.clearcoat');
    program.fragmentShader=program.fragmentShader.replace('#include <opaque_fragment>',`
      outgoingLight+=reflectedContactLight;
      #include <opaque_fragment>
    `);
  };
  material.customProgramCacheKey=()=> 'membrane-sphere-display-v9';
  membrane=new THREE.Mesh(new THREE.PlaneGeometry(1,1),material);
  membrane.frustumCulled=false;
  scene.add(membrane);
  updateStudioEnvironment();
  scene.add(new THREE.HemisphereLight('#eee3db','#a3918d',.8));
  contactScene.add(new THREE.HemisphereLight('#ffffff','#71615d',3));
  studioLights.push(...scene.children.filter(o=>o.isLight&&o!==contactLight),...contactScene.children.filter(o=>o.isLight));
  for(const light of studioLights)light.userData.dayIntensity=light.intensity;
  composer=keep(new EffectComposer(renderer));
  composer.renderTarget1.samples=Math.min(4,renderer.capabilities.maxSamples);
  composer.renderTarget2.samples=Math.min(4,renderer.capabilities.maxSamples);
  renderPass=keep(new RenderPass(scene,camera));
  bloomPass=keep(new UnrealBloomPass(new THREE.Vector2(stage.clientWidth,stage.clientHeight),.25,.65,1.));
  composer.addPass(renderPass);composer.addPass(bloomPass);composer.addPass(keep(new OutputPass()));
  resize();
  const gltf=await new GLTFLoader().loadAsync('./cross-ball.glb');
  const shape=gltf.scene.getObjectByName('Cross_Sphere');
  emitterShape=shape;
  if(!shape||!shape.isMesh)throw new Error('В cross-ball.glb не найден объект Cross_Sphere.');
  model=new THREE.Group();
  model.add(shape);
  model.updateMatrixWorld(true);
  const bounds=new THREE.Box3().setFromObject(model),center=bounds.getCenter(new THREE.Vector3()),extent=bounds.getSize(new THREE.Vector3());
  const scale=(1.8408*1.2)/Math.max(extent.x,extent.y,extent.z);
  model.position.copy(center).multiplyScalar(-scale);model.scale.setScalar(scale);
  contactHalfDepth=extent.z*scale/2;
  modelRoot.add(model);
  modelRoot.position.z=state.pressure-contactHalfDepth;
  model.traverse(object=>{if(object.isMesh){object.geometry.computeVertexNormals();keep(object.geometry);if(object.material)keep(object.material);}});
  model.traverse(object=>{if(object.isMesh)for(const mat of [].concat(object.material)){
    if(!mat.emissive)continue;
    modelMaterials.set(mat,{emissive:mat.emissive.clone(),intensity:mat.emissiveIntensity});
    mat.onBeforeCompile=program=>{
      Object.assign(program.uniforms,displayUniforms);
      program.vertexShader='varying vec3 displayLocalPosition;\n'+program.vertexShader;
      program.vertexShader=program.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\ndisplayLocalPosition=position;');
      program.fragmentShader=displayGLSL+'varying vec3 displayLocalPosition;\n'+program.fragmentShader;
      program.fragmentShader=program.fragmentShader.replace('#include <emissivemap_fragment>',`
        #include <emissivemap_fragment>
        float modelFacing=clamp(abs(dot(normalize(normal),normalize(vViewPosition))),0.,1.);
        float modelRim=pow(1.-modelFacing,2.);
        totalEmissiveRadiance*=.22+.9*modelRim;
        totalEmissiveRadiance+=displayEmission(displayLocalPosition,0.);
      `);
    };
    mat.customProgramCacheKey=()=> 'sphere-surface-display-v2';
  }});
  opticalRoot=modelRoot.clone(true);
  opticalRoot.name='Refractive backing';
  scene.add(opticalRoot);
  // Unselected meshes from the exported file are not part of this prototype.
  const activeMaterials=new Set();
  model.traverse(object=>{if(object.isMesh)for(const mat of [].concat(object.material))activeMaterials.add(mat);});
  gltf.scene.traverse(object=>{if(object.isMesh){object.geometry.dispose();for(const mat of [].concat(object.material))if(!activeMaterials.has(mat))mat.dispose();}});
  applyTheme();
  status.textContent='Мембрана · cross-ball.glb';
  const breathButton=document.querySelector('#breath');
  breathButton.setAttribute('aria-pressed',String(state.breath));
  breathButton.textContent='Дыхание: '+(state.breath?'вкл':'выкл');
  ready=true;
  window.addEventListener('resize',resize);
  // Warm up at a fixed step so the first visible frame already has a form.
  updateContact(1);
  for(let i=0;i<180;i++)tick(1/120);
  lastTime=performance.now();
  raf=requestAnimationFrame(animate);
}

start().catch(error=>{console.error(error);status.textContent='Ошибка: '+error.message;stage.style.background='radial-gradient(ellipse at 60% 50%,#ded0cb,#b8a6a2 65%)';});
window.addEventListener('pagehide',()=>{
  disposed=true;clearTimeout(lightingTimer);cancelAnimationFrame(raf);window.removeEventListener('resize',resize);
  contactTarget?.dispose();targets?.forEach(t=>t.dispose());membrane?.geometry.dispose();
  resources.forEach(resource=>resource.dispose());renderer?.dispose();
},{once:true});
