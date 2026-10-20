// Copied from awk-landing src/shaders.ts (VS, LOGO_FS, fullscreenProgram) — keep in sync with the landing.
// GLSL ported as-is from the Claude Design file "Any Wallet Kit v6" (hero raymarch with the uLight branch + liquid-glass logo pill).

export const VS = `#version 300 es
in vec2 p; void main(){ gl_Position = vec4(p,0.,1.); }`;

export const LOGO_FS = `#version 300 es
precision highp float;
uniform vec2 uRes; uniform float uT; out vec4 o;
float cap(vec2 p, float a, float r){ vec2 q=vec2(max(abs(p.x)-a,0.),p.y); return length(q)-r; }
float wob(vec2 p, float t){ return sin(p.x*5.3+t*1.3)*sin(p.y*6.1-t*1.1)*.016 + sin(p.x*9.7-t*1.9+p.y*3.)*.008 + sin(atan(p.y,p.x)*3.+t*.8)*.008; }
float D(vec2 p, float A, float R, float t){ return cap(p,A,R) + wob(p,t); }
void main(){
  vec2 p=(gl_FragCoord.xy-.5*uRes)/uRes.y;
  float asp=uRes.x/uRes.y, R=.44, A=asp*.5-.5, px=1.5/uRes.y, t=uT;
  float d=D(p,A,R,t);
  float inside=1.-smoothstep(-px,px,d);
  if(d>px*2.){ o=vec4(0.); return; }
  float e=.004;
  vec2 g=normalize(vec2(D(p+vec2(e,0.),A,R,t)-d, D(p+vec2(0.,e),A,R,t)-d)+1e-6);
  float edge=-d, W=.15;
  float rim=1.-smoothstep(0.,W,edge);
  float h=sqrt(max(1.-pow(1.-clamp(edge/W,0.,1.),2.),0.));
  vec3 n=normalize(vec3(g*(1.-h)*1.6,h+.15));
  float ndv=n.z;
  vec3 L=normalize(vec3(-.45,.75,.6));
  float lit=max(dot(n,L),0.);
  float spec=pow(max(dot(reflect(vec3(0.,0.,-1.),n),L),0.),32.);
  float along=atan(p.y,p.x)*.5 + p.x*.8;
  float flow=along + t*.22 + sin(p.y*7.+t*1.4)*.12 + sin(p.x*4.-t)*.1;
  vec3 film=.5+.5*cos(6.2831*(vec3(0.,.33,.67)+flow+(1.-ndv)*1.1));
  film=mix(film,vec3(1.),.18);
  vec3 col=vec3(.12,.13,.16);
  float al=.2;
  float fr=pow(1.-ndv,1.6);
  col=mix(col, film*(.6+.5*lit), rim*(.7+.3*fr));
  al=mix(al,.9,rim*(.4+.6*fr));
  float inner=exp(-pow((edge-W*.95)/.018,2.));
  col-=inner*.12; al=max(al,inner*.35);
  col+=vec3(1.)*spec*1.1*rim; al=max(al,spec*rim);
  float outer=exp(-pow(edge/.012,2.));
  col+=vec3(1.)*outer*(.25+.6*max(g.y,0.)); al=max(al,outer*.9);
  col+=vec3(1.)*smoothstep(.1,.36,p.y)*smoothstep(W*.8,W*1.4,edge)*.12;
  col+=vec3(.85,.92,1.)*smoothstep(-.12,-.38,p.y)*smoothstep(W*.8,W*1.6,edge)*.08;
  o=vec4(col,al*inside);
}`;

/** Compiles a full-screen-triangle program; returns null (and warns) when the shader does not compile. */
export function fullscreenProgram(gl: WebGL2RenderingContext, fs: string): WebGLProgram | null {
  const sh = (type: number, src: string): WebGLShader | null => {
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn(gl.getShaderInfoLog(s));
      gl.deleteShader(s);
      return null;
    }
    return s;
  };
  const vs = sh(gl.VERTEX_SHADER, VS), fsh = sh(gl.FRAGMENT_SHADER, fs);
  if (!vs || !fsh) return null;
  const pr = gl.createProgram();
  if (!pr) return null;
  gl.attachShader(pr, vs);
  gl.attachShader(pr, fsh);
  gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) {
    console.warn(gl.getProgramInfoLog(pr));
    return null;
  }
  gl.useProgram(pr);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(pr, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  return pr;
}
