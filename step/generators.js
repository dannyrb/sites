// populates Fields with data based on inputs
class Generator {  // TODO: unify with Space
  constructor(options={}) {

    this.gl = options.gl;
    this.uniforms = options.uniforms || {};
    this.uniforms.gradientSize = { type: '1f', value: .01 };
    this.inputFields = options.inputFields || [];
    this.outputFields = options.outputFields || [];
    this.program = undefined;
  }

  // utility for printing multiline strings for debugging
  logWithLineNumbers(string) {
    let lineNumber = 1;
    string.split("\n").forEach(line=>{
      console.log(lineNumber, line);
      lineNumber += 1;
    });
  }
}

// Uses a GL program to generate fields
class ProgrammaticGenerator extends Generator {
  constructor(options={}) {
    super(options);
    this.uniforms.squiggle = { type: '1f', value: 1. };
    let gl = this.gl;

    this.outputFields.forEach(outputField=>{
      outputField.generator = this;
    });

    // buffers for the textured plane in normalized (clip) space
    let renderImageVertices = [ -1., -1., 0.,
                                 1., -1., 0.,
                                -1.,  1., 0.,
                                 1.,  1., 0., ];
    this.renderImageCoordinatesBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.renderImageCoordinatesBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(renderImageVertices), gl.STATIC_DRAW);

    let renderImageTextureCoordinates = [ 0., 0.,
                                          1., 0.,
                                          0., 1.,
                                          1., 1. ];
    this.renderImageTexureCoordinatesBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.renderImageTexureCoordinatesBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(renderImageTextureCoordinates), gl.STATIC_DRAW);

    // framebuffer to attach texture layer for generating a slice
    this.framebuffer = gl.createFramebuffer();
    
    this.updateProgram();
  }

  headerSource() {
    return(`#version 300 es
      precision highp float;
      precision highp int;
      precision highp sampler3D;
      precision highp isampler3D;
    `);
  }

  _vertexShaderSource() {
    return (`${this.headerSource()}
      layout(location = 0) in vec3 coordinate;
      layout(location = 1) in vec2 textureCoordinate;
      uniform float slice;
      out vec3 interpolatedTextureCoordinate;
      void main()
      {
        interpolatedTextureCoordinate = vec3(textureCoordinate, slice);
        gl_Position = vec4(coordinate, 1.);
      }
    `);
  }

  _fragmentShaderSource() {
    return (`${this.headerSource()}

      uniform int iteration;
      uniform int iterations;

      // these are the function definitions for sampleVolume* and transferFunction*
      // that define a field at a sample point in space
      ${function() {
          let perFieldSamplingShaderSource = '';
          this.inputFields.forEach(field=>{
            perFieldSamplingShaderSource += field.samplingShaderSource();
          });
          return(perFieldSamplingShaderSource);
        }.bind(this)()
      }

      in vec3 interpolatedTextureCoordinate;
      out int fragmentColor;

      uniform float gradientSize;
      uniform float squiggle;
      uniform isampler3D inputTexture;

      float sampleValue;
      float gradientMagnitude;
      vec3 normal;

      void main()
      {
        fragmentColor = texture(textureUnit${this.inputFields[0].id}, interpolatedTextureCoordinate).r;
        fragmentColor *= int(squiggle * (sin(20.*interpolatedTextureCoordinate.s) + cos(20.*interpolatedTextureCoordinate.t)));
      }
    `);
  }

  updateProgram() {
    // recreate the program
    let gl = this.gl;
    if (this.program) {gl.deleteProgram(this.program);}

    this.vertexShaderSource = this._vertexShaderSource();
    this.fragmentShaderSource = this._fragmentShaderSource();

    // the program and shaders
    this.program = gl.createProgram();
    this.vertexShader = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(this.vertexShader, this.vertexShaderSource);
    gl.compileShader(this.vertexShader);
    if (!gl.getShaderParameter(this.vertexShader, gl.COMPILE_STATUS)) {
      this.logWithLineNumbers(this.vertexShaderSource);
      console.error('Could not compile vertexShader');
      console.log(gl.getShaderInfoLog(this.vertexShader));
      return;
    }
    this.fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(this.fragmentShader, this.fragmentShaderSource);
    gl.compileShader(this.fragmentShader);
    if (!gl.getShaderParameter(this.fragmentShader, gl.COMPILE_STATUS)) {
      this.logWithLineNumbers(this.fragmentShaderSource);
      console.error('Could not compile fragmentShader');
      console.log(gl.getShaderInfoLog(this.fragmentShader));
      return;
    }
    gl.attachShader(this.program, this.vertexShader);
    gl.deleteShader(this.vertexShader);
    gl.attachShader(this.program, this.fragmentShader);
    gl.deleteShader(this.fragmentShader);
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      this.logWithLineNumbers(this.fragmentShaderSource);
      console.error('Could not link program');
      console.log(gl.getProgramInfoLog(this.program));
      return;
    }

    // activate the inputs
    this.inputFields.forEach(field => {
      if (field.needsUpdate()) {
        field.fieldToTexture(gl)
      }
    });
  }

  _setUniform(key, uniform) {
    let gl = this.gl;
    let location = gl.getUniformLocation(this.program, key);
    if (uniform.type == '3fv') {gl.uniform3fv(location, uniform.value); return;}
    if (uniform.type == '3iv') {gl.uniform3iv(location, uniform.value); return;}
    if (uniform.type == '3fv') {gl.uniform3fv(location, uniform.value); return;}
    if (uniform.type == '1f') {gl.uniform1f(location, uniform.value); return;}
    if (uniform.type == '1ui') {gl.uniform1ui(location, uniform.value); return;}
    if (uniform.type == '1i') {gl.uniform1i(location, uniform.value); return;}
    if (uniform.type == 'Matrix3fv') {gl.uniformMatrix3fv(location, gl.FALSE, uniform.value); return;}
    if (uniform.type == 'Matrix4fv') {gl.uniformMatrix4fv(location, gl.FALSE, uniform.value); return;}
    console.error('Could not set uniform', key, uniform);
  }

  generate() {
    let gl = this.gl;

    gl.useProgram(this.program);

    // the coordinate attribute
    gl.bindBuffer(gl.ARRAY_BUFFER, this.renderImageCoordinatesBuffer);
    let coordinateLocation = gl.getAttribLocation(this.program, "coordinate");
    gl.enableVertexAttribArray( coordinateLocation );
    gl.vertexAttribPointer( coordinateLocation, 3, gl.FLOAT, false, 0, 0);

    // the textureCoordinate attribute
    gl.bindBuffer(gl.ARRAY_BUFFER, this.renderImageTexureCoordinatesBuffer);
    let textureCoordinateLocation = gl.getAttribLocation(this.program, "textureCoordinate");
  textureCoordinateLocation = 1; // TODO
    gl.enableVertexAttribArray( textureCoordinateLocation );
    gl.vertexAttribPointer( textureCoordinateLocation, 2, gl.FLOAT, false, 0, 0);

    // the overall application uniforms, and the per-field uniforms
    Object.keys(this.uniforms).forEach(key=>{
      this._setUniform(key, this.uniforms[key]);
    });
    this.inputFields.forEach(field=>{
      let uniforms = field.uniforms();
      Object.keys(uniforms).forEach(key=>{
        this._setUniform(key, uniforms[key]);
      });
    });

    // activate any field textures
    this.inputFields.forEach(field=>{
      gl.activeTexture(gl.TEXTURE0+field.id);
      if (field.texture) {
        gl.bindTexture(gl.TEXTURE_3D, field.texture);
      }
    });

    // generate the output by invoking the program once per slice
    let mipmapLevel = 0;
    let sliceUniformLocation = gl.getUniformLocation(this.program, "slice");
    let outputField = this.outputFields[0];
    let outputDataset = outputField.dataset;
    let sharedGroups = outputDataset.SharedFunctionalGroups;
    let sliceSpacing = sharedGroups.PixelMeasures.SpacingBetweenSlices;
    let slice = 0.5 * sliceSpacing;
    for (let sliceIndex = 0; sliceIndex < outputDataset.NumberOfFrames; sliceIndex++) {
      slice = sliceIndex / outputDataset.NumberOfFrames;
      gl.uniform1f(sliceUniformLocation, slice);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
                                 outputField.texture, mipmapLevel, sliceIndex);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      slice += sliceSpacing;
    }
  }
}
