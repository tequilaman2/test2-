// Основные переменные приложения
const models = {
  cat: {
    glb: 'models/cat.glb',
    usdz: 'models/cat.usdz',
    scale: 0.5,
    rotationOffset: 0
  },
  chair: {
    glb: 'models/model.glb', 
    usdz: 'models/model.usdz',
    scale: 0.3,
    rotationOffset: Math.PI
  },
  apple: {
    glb: 'models/apple.glb',
    scale: 0.3,
    rotationOffset: 0
  }
};

// Элементы DOM
const elements = {
  loadingScreen: document.getElementById('loading-screen'),
  arMessage: document.getElementById('ar-message'),
  arContainer: document.getElementById('ar-container'),
  modelItems: document.querySelectorAll('.model-item'),
  placeButton: document.getElementById('place-btn'),
  rotateButton: document.getElementById('rotate-btn'),
  resetButton: document.getElementById('reset-btn'),
  arModeIndicator: document.getElementById('ar-mode-indicator')
};

// Состояние приложения
const state = {
  isLoading: true,
  arMode: false,
  placingMode: false,
  rotatingMode: false,
  currentModelIndex: 0,
  placedModels: [],
  selectedModelId: 'cat',
  touchStartTime: 0,
  longPressThreshold: 700, // миллисекунды
  modelLoaded: false,
  qrCodeDetected: false,
  targetFound: false
};

// Объекты Three.js
let THREE;
let scene, camera, renderer;
let mindarThree;
let gltfLoader;
let modelAnchor;
let currentModel;
let modelContainerGroup;
let placedModelsGroup;
let qrAnchor;
let mixers = [];
let clock;
let videoTexture;
let placementIndicator;
let raycaster;
let mouse;
let video;

// Запуск приложения
async function initApp() {
  try {
    showMessage('Инициализация AR...');
    
    // Инициализируем Three.js глобальные переменные
    THREE = window.THREE;
    clock = new THREE.Clock();
    raycaster = new THREE.Raycaster();
    mouse = new THREE.Vector2();
    
    try {
      // Пытаемся создать mind-ar контекст, если есть targets.mind
      mindarThree = new window.MINDAR.IMAGE.MindARThree({
        container: elements.arContainer,
        imageTargetSrc: 'targets.mind',
        filterMinCF: 0.0001,
        filterBeta: 0.001,
        missTolerance: 5,
        warmupTolerance: 5,
        cameraSwitchDelay: 800
      });
      
      // Получаем renderer, scene и camera из mind-ar
      renderer = mindarThree.renderer;
      scene = mindarThree.scene;
      camera = mindarThree.camera;
    } catch (error) {
      console.log('Не удалось инициализировать MindAR с targets.mind, создаем базовый AR контекст:', error);
      
      // Создаем простой контекст с AR.js или простую сцену Three.js
      // с доступом к камере для сканирования QR-кодов
      const width = window.innerWidth;
      const height = window.innerHeight;
      
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setSize(width, height);
      renderer.setPixelRatio(window.devicePixelRatio);
      elements.arContainer.appendChild(renderer.domElement);
      
      scene = new THREE.Scene();
      
      // Создаем камеру
      camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
      camera.position.set(0, 0, 5);
      
      // Запускаем видео с камеры вручную
      video = document.createElement('video');
      video.setAttribute('autoplay', '');
      video.setAttribute('muted', '');
      video.setAttribute('playsinline', '');
      
      // Получаем доступ к камере
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
          .then(function(stream) {
            video.srcObject = stream;
            video.play();
            
            // Создаем видео текстуру для фона
            videoTexture = new THREE.VideoTexture(video);
            const videoMaterial = new THREE.MeshBasicMaterial({ map: videoTexture });
            const videoGeometry = new THREE.PlaneGeometry(1, 1);
            const videoMesh = new THREE.Mesh(videoGeometry, videoMaterial);
            
            // Устанавливаем размер видео на задний план
            const videoAspect = video.videoWidth / video.videoHeight;
            const screenAspect = width / height;
            
            if (videoAspect > screenAspect) {
              videoMesh.scale.set(1, videoAspect / screenAspect, 1);
            } else {
              videoMesh.scale.set(screenAspect / videoAspect, 1, 1);
            }
            
            // Создаем отдельную сцену для видео
            const videoScene = new THREE.Scene();
            const videoCamera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 10);
            videoScene.add(videoMesh);
            
            // Обновляем функцию рендеринга
            renderer.autoClear = false;
            
            const originalRenderFunc = renderer.render;
            renderer.render = function() {
              renderer.clear();
              originalRenderFunc.call(renderer, videoScene, videoCamera);
              originalRenderFunc.call(renderer, scene, camera);
            };
          })
          .catch(function(error) {
            console.error('Ошибка доступа к камере:', error);
            showMessage('Ошибка доступа к камере: ' + error.message);
          });
      }
    }
    
    // Настраиваем рендерер
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.physicallyCorrectLights = true;
    
    // Настраиваем освещение сцены
    setupLighting();
    
    // Создаем загрузчик моделей
    gltfLoader = new THREE.GLTFLoader();
    
    // Создаем группу для всех размещенных моделей
    placedModelsGroup = new THREE.Group();
    scene.add(placedModelsGroup);
    
    // Создаем контейнер для текущей модели
    modelContainerGroup = new THREE.Group();
    
    // Создаем индикатор размещения
    createPlacementIndicator();
    
    // Инициализируем QR-сканер
    initQRScanner();
    
    // Получаем якорь для первого целевого изображения
    if (mindarThree) {
      try {
        const numOfTargets = mindarThree.addTargets ? mindarThree.addTargets('targets.mind').length : 0;
        if (numOfTargets > 0) {
          qrAnchor = mindarThree.addAnchor(0);
          qrAnchor.group.add(modelContainerGroup);
          
          // Обработчик обнаружения целевого изображения
          qrAnchor.onTargetFound = () => {
            state.targetFound = true;
            showMessage('Цель обнаружена!');
          };
          
          // Обработчик потери целевого изображения
          qrAnchor.onTargetLost = () => {
            state.targetFound = false;
            showMessage('Наведите камеру на QR-код');
          };
        } else {
          // Если нет мишеней, просто добавляем контейнер для модели в сцену
          scene.add(modelContainerGroup);
        }
      } catch (error) {
        console.log('Ошибка при добавлении targets:', error);
        // Если произошла ошибка, просто добавляем контейнер для модели в сцену
        scene.add(modelContainerGroup);
      }
    } else {
      // Если mindarThree не инициализирован, добавляем контейнер для модели в сцену
      scene.add(modelContainerGroup);
    }
    
    // Загружаем первую модель
    await loadModel('cat');
    
    // Запускаем AR, если инициализирован mindarThree
    if (mindarThree) {
      await mindarThree.start();
      video = mindarThree.video;
    }
    
    // Настраиваем анимацию
    setupAnimation();
    
    // Скрываем экран загрузки
    hideLoading();
    
    // Инициализируем обработчики событий
    setupEventListeners();
    
    showMessage('Наведите камеру на QR-код');
    
  } catch (error) {
    console.error('Ошибка инициализации:', error);
    showMessage('Ошибка инициализации AR: ' + error.message);
  }
}

// Инициализация QR-сканера
function initQRScanner() {
  if (!video) return;
  
  // Убедимся, что jsQR доступен
  if (!window.jsQR) {
    console.warn('Библиотека jsQR не найдена, загружаем динамически');
    const script = document.createElement('script');
    script.src = 'jsQR.js';
    script.onload = () => {
      console.log('jsQR загружен динамически');
      // После загрузки библиотеки продолжаем инициализацию сканера
      startQRScanning();
    };
    script.onerror = () => console.error('Не удалось загрузить jsQR динамически');
    document.head.appendChild(script);
  } else {
    // Если библиотека уже доступна, начинаем сканирование
    startQRScanning();
  }
}

// Запуск постоянного сканирования QR-кодов
function startQRScanning() {
  // Сканируем QR-код каждый кадр в анимационном цикле, 
  // отдельный интервал не нужен, так как scanQRCode вызывается в setupAnimation
  
  // Однако, добавим периодическую проверку на сброс состояния, 
  // чтобы можно было обнаружить QR-код снова, если он исчез и появился
  setInterval(() => {
    if (state.qrCodeDetected) {
      // Проверяем, все еще ли виден QR-код
      checkIfQRStillVisible();
    }
  }, 2000);
}

// Сканирование QR-кода
function scanQRCode() {
  if (!video || !window.jsQR) return;
  
  try {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    const width = video.videoWidth;
    const height = video.videoHeight;
    
    if (width === 0 || height === 0) return;
    
    canvas.width = width;
    canvas.height = height;
    context.drawImage(video, 0, 0, width, height);
    
    const imageData = context.getImageData(0, 0, width, height);
    const code = jsQR(imageData.data, width, height);
    
    if (code) {
      console.log('QR код обнаружен:', code.data);
      showMessage('QR-код обнаружен');
      
      if (!state.qrCodeDetected) {
        // Запоминаем положение QR-кода
        state.lastQRCodePosition = {
          x: code.location.topLeftCorner.x,
          y: code.location.topLeftCorner.y,
          width: Math.abs(code.location.topRightCorner.x - code.location.topLeftCorner.x),
          height: Math.abs(code.location.bottomLeftCorner.y - code.location.topLeftCorner.y)
        };
        
        // Устанавливаем флаг обнаружения QR-кода
        state.qrCodeDetected = true;
        
        // Делаем модель видимой (это произойдет в setupAnimation)
        
        // Устанавливаем позицию контейнера модели в соответствии с QR-кодом
        positionModelOnQRCode(code);
      } else {
        // Обновляем позицию контейнера модели, если QR-код перемещается
        positionModelOnQRCode(code);
      }
      
      // Сохраняем время последнего обнаружения QR-кода
      state.lastQRDetectionTime = Date.now();
    }
  } catch (error) {
    console.error('Ошибка при сканировании QR-кода:', error);
  }
}

// Проверка, все еще ли виден QR-код
function checkIfQRStillVisible() {
  // Если прошло более 1 секунды с момента последнего обнаружения QR-кода,
  // считаем, что QR-код больше не виден
  const now = Date.now();
  const timeSinceLastDetection = now - (state.lastQRDetectionTime || 0);
  
  if (timeSinceLastDetection > 1000) {
    state.qrCodeDetected = false;
    state.lastQRCodePosition = null;
    showMessage('QR-код потерян. Наведите камеру на QR-код снова');
  }
}

// Позиционирование модели на QR-коде
function positionModelOnQRCode(code) {
  if (!currentModel || !modelContainerGroup) return;
  
  try {
    // Вычисляем центр QR-кода в пикселях видеопотока
    const centerX = (code.location.topLeftCorner.x + code.location.bottomRightCorner.x) / 2;
    const centerY = (code.location.topLeftCorner.y + code.location.bottomRightCorner.y) / 2;
    
    // Вычисляем размер QR-кода
    const qrWidth = Math.abs(code.location.topRightCorner.x - code.location.topLeftCorner.x);
    const qrHeight = Math.abs(code.location.bottomLeftCorner.y - code.location.topLeftCorner.y);
    const qrSize = Math.max(qrWidth, qrHeight);
    
    // Если у нас есть автоматическое позиционирование через MindAR или ARjs,
    // мы не трогаем позицию модели
    if (mindarThree && qrAnchor) {
      return;
    }
    
    // Преобразуем координаты из пикселей видео в координаты 3D-сцены
    // Для простоты используем фиксированное значение глубины
    const modelScale = qrSize / Math.max(video.videoWidth, video.videoHeight) * 2;
    
    // Устанавливаем масштаб модели пропорционально размеру QR-кода
    if (currentModel) {
      const modelInfo = models[state.selectedModelId];
      const baseScale = modelInfo.scale || 0.5;
      currentModel.scale.set(
        baseScale * modelScale,
        baseScale * modelScale,
        baseScale * modelScale
      );
    }
    
    // В режиме без MindAR, мы должны позиционировать модель вручную
    if (!mindarThree) {
      // Преобразуем координаты из пикселей в нормализованные координаты (-1 до 1)
      const normX = (centerX / video.videoWidth) * 2 - 1;
      const normY = -(centerY / video.videoHeight) * 2 + 1;
      
      // Устанавливаем позицию модели в сцене
      modelContainerGroup.position.set(normX, normY, -1);
    }
  } catch (error) {
    console.error('Ошибка при позиционировании модели на QR-коде:', error);
  }
}

// Настройка освещения
function setupLighting() {
  // Создаем ambient light
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
  scene.add(ambientLight);
  
  // Создаем directional light
  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
  directionalLight.position.set(0, 10, 0);
  scene.add(directionalLight);
  
  // Добавляем hemisphere light для более естественного освещения
  const hemisphereLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.8);
  scene.add(hemisphereLight);
}

// Создание индикатора размещения
function createPlacementIndicator() {
  // Создаем индикатор размещения (визуальный маркер)
  const geometry = new THREE.CircleGeometry(0.1, 32);
  const material = new THREE.MeshBasicMaterial({
    color: 0x4285f4,
    transparent: true,
    opacity: 0.6,
    side: THREE.DoubleSide
  });
  
  placementIndicator = new THREE.Mesh(geometry, material);
  placementIndicator.rotation.x = -Math.PI / 2; // Разворачиваем горизонтально
  placementIndicator.visible = false;
  
  scene.add(placementIndicator);
}

// Загрузка 3D модели
async function loadModel(modelId) {
  state.modelLoaded = false;
  state.selectedModelId = modelId;
  
  const modelInfo = models[modelId];
  
  // Очищаем предыдущую модель
  if (currentModel) {
    modelContainerGroup.remove(currentModel);
    currentModel = null;
  }
  
  try {
    showMessage('Загрузка модели...');
    
    // Загружаем модель
    const gltf = await new Promise((resolve, reject) => {
      gltfLoader.load(
        modelInfo.glb,
        (gltf) => resolve(gltf),
        (xhr) => console.log((xhr.loaded / xhr.total * 100) + '% загружено'),
        (error) => reject(error)
      );
    });
    
    // Клонируем модель
    const model = gltf.scene;
    model.scale.set(modelInfo.scale, modelInfo.scale, modelInfo.scale);
    model.position.set(0, 0, 0);
    
    // Применяем смещение вращения, если оно указано
    if (modelInfo.rotationOffset !== undefined) {
      model.rotation.set(0, modelInfo.rotationOffset, 0);
    }
    
    // Центрируем модель
    centerModel(model);
    
    // Добавляем кнопки к модели
    addButtonsToModel(model);
    
    // Настраиваем анимацию
    setupModelAnimation(model, gltf);
    
    // Добавляем модель в контейнер
    modelContainerGroup.add(model);
    currentModel = model;
    
    // Настраиваем вращение модели
    setupModelRotation();
    
    state.modelLoaded = true;
    showMessage('Модель загружена. Наведите на QR-код');
    
  } catch (error) {
    console.error('Ошибка загрузки модели:', error);
    showMessage('Ошибка загрузки модели');
  }
}

// Центрирование модели
function centerModel(model) {
  // Вычисляем границы модели
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  
  // Вычисляем смещение для центрирования
  const offset = center.negate();
  model.position.add(offset);
  
  // Поднимаем модель над поверхностью
  const height = box.max.y - box.min.y;
  model.position.y += height / 2;
}

// Настройка анимации модели
function setupModelAnimation(model, gltf) {
  // Очищаем старые миксеры анимаций
  mixers = [];
  
  // Проверяем наличие анимаций
  if (gltf.animations && gltf.animations.length > 0) {
    const mixer = new THREE.AnimationMixer(model);
    const animation = gltf.animations[0];
    
    // Проверяем тип анимации
    if (animation.tracks.some(track => track.name.includes('rotation'))) {
      // Анимация вращения
      const action = mixer.clipAction(animation);
      action.play();
    } else {
      // Другие типы анимаций
      const action = mixer.clipAction(animation);
      action.setLoop(THREE.LoopRepeat);
      action.play();
    }
    
    mixers.push(mixer);
  }
}

// Добавление кнопок к модели
function addButtonsToModel(model) {
  // Вычисляем границы модели для размещения кнопок
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const height = size.y;
  const width = size.x;
  
  // Создаем группу для кнопок
  const buttonsGroup = new THREE.Group();
  
  // Загружаем текстуры для кнопок из файлов
  const textureLoader = new THREE.TextureLoader();
  
  // Размер кнопок
  const buttonSize = 0.08;
  
  // Функция для создания кнопки с изображением
  const createButtonWithImage = (imagePath, position, action) => {
    return new Promise((resolve) => {
      textureLoader.load(
        imagePath,
        (texture) => {
          // Создаем геометрию для кнопки (прямоугольник с соотношением сторон как у текстуры)
          const aspect = texture.image.width / texture.image.height;
          const buttonGeometry = new THREE.PlaneGeometry(buttonSize * aspect, buttonSize);
          
          // Создаем материал с текстурой
          const buttonMaterial = new THREE.MeshBasicMaterial({
            map: texture,
            transparent: true,
            opacity: 1.0
          });
          
          // Создаем кнопку
          const button = new THREE.Mesh(buttonGeometry, buttonMaterial);
          button.position.copy(position);
          button.userData = { type: 'button', action: action };
          
          // Добавляем кнопку в группу
          buttonsGroup.add(button);
          resolve(button);
        },
        undefined,
        (error) => {
          console.error('Ошибка загрузки текстуры:', error);
          // Создаем запасной вариант кнопки с текстом
          const fallbackTexture = createTextTexture(action === 'www' ? 'WWW' : 'EM', 128, 128);
          const buttonGeometry = new THREE.CircleGeometry(buttonSize/2, 32);
          const buttonMaterial = new THREE.MeshBasicMaterial({
            map: fallbackTexture,
            transparent: true,
            opacity: 0.9
          });
          
          const button = new THREE.Mesh(buttonGeometry, buttonMaterial);
          button.position.copy(position);
          button.userData = { type: 'button', action: action };
          
          buttonsGroup.add(button);
          resolve(button);
        }
      );
    });
  };
  
  // Создаем и добавляем кнопки
  Promise.all([
    createButtonWithImage('site.png', new THREE.Vector3(width * 0.4, height * 0.5, 0), 'www'),
    createButtonWithImage('em.png', new THREE.Vector3(-width * 0.4, height * 0.5, 0), 'email')
  ]).then(buttons => {
    // Функция для обеспечения биллбординга (всегда смотрят на камеру)
    const updateButtonOrientation = () => {
      if (camera) {
        const cameraPosition = new THREE.Vector3();
        camera.getWorldPosition(cameraPosition);
        
        buttons.forEach(button => {
          button.lookAt(cameraPosition);
        });
      }
    };
    
    // Добавляем функцию обновления в userData
    buttonsGroup.userData = { 
      type: 'buttons',
      update: updateButtonOrientation
    };
  });
  
  // Добавляем группу кнопок к модели
  model.add(buttonsGroup);
}

// Создание текстуры с текстом
function createTextTexture(text, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  
  const context = canvas.getContext('2d');
  
  // Заполняем фон
  context.fillStyle = '#FFFFFF';
  context.beginPath();
  context.arc(width/2, height/2, width/2.2, 0, Math.PI * 2);
  context.fill();
  
  // Рисуем текст
  context.fillStyle = '#000000';
  context.font = 'bold ' + (width * 0.3) + 'px Arial';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, width/2, height/2);
  
  // Создаем текстуру
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  
  return texture;
}

// Настройка вращения модели
function setupModelRotation() {
  if (currentModel) {
    // Устанавливаем параметры вращения
    currentModel.userData.autoRotate = true;
    currentModel.userData.rotationSpeed = 0.01; // Скорость вращения
    currentModel.userData.rotationAxis = new THREE.Vector3(0, 1, 0); // Вертикальная ось
  }
}

// Настройка анимации
function setupAnimation() {
  renderer.setAnimationLoop(() => {
    // Обновляем миксеры анимаций
    const delta = clock.getDelta();
    mixers.forEach(mixer => mixer.update(delta));
    
    // Обновляем ориентацию кнопок на моделях
    updateModelButtons();
    
    // Модель должна быть видна только при обнаружении QR-кода или маркера
    if (currentModel) {
      // Проверяем, должна ли модель быть видимой
      const shouldBeVisible = state.qrCodeDetected || state.targetFound;
      
      // Если модель в контейнере modelContainerGroup
      if (modelContainerGroup.children.includes(currentModel)) {
        // Показываем модель только если обнаружен QR-код или маркер
        modelContainerGroup.visible = shouldBeVisible;
        
        // Вращаем текущую модель, если нужно
        if (shouldBeVisible && currentModel.userData.autoRotate && !state.placingMode && !state.rotatingMode) {
          const axis = currentModel.userData.rotationAxis || new THREE.Vector3(0, 1, 0);
          const speed = currentModel.userData.rotationSpeed || 0.01;
          
          currentModel.rotateOnAxis(axis, speed);
        }
      }
    }
    
    // Обновляем индикатор размещения
    if (state.placingMode && placementIndicator) {
      updatePlacementIndicator();
    }
    
    // Обновляем сканирование QR-кода
    if (video && video.readyState === video.HAVE_ENOUGH_DATA && !state.qrCodeDetected) {
      scanQRCode();
    }
    
    // Отрисовываем сцену
    renderer.render(scene, camera);
  });
}

// Обновление кнопок на моделях
function updateModelButtons() {
  // Обновляем кнопки на текущей модели
  if (currentModel) {
    currentModel.traverse((child) => {
      if (child.userData && child.userData.type === 'buttons' && child.userData.update) {
        child.userData.update();
      }
    });
  }
  
  // Обновляем кнопки на размещенных моделях
  state.placedModels.forEach(item => {
    if (item.model) {
      item.model.traverse((child) => {
        if (child.userData && child.userData.type === 'buttons' && child.userData.update) {
          child.userData.update();
        }
      });
    }
  });
}

// Обновление индикатора размещения
function updatePlacementIndicator() {
  if (!placementIndicator || !camera) return;
  
  // Получаем положение и ориентацию камеры
  const cameraPosition = new THREE.Vector3();
  const cameraQuaternion = new THREE.Quaternion();
  
  camera.getWorldPosition(cameraPosition);
  camera.getWorldQuaternion(cameraQuaternion);
  
  // Вычисляем направление взгляда
  const direction = new THREE.Vector3(0, 0, -1);
  direction.applyQuaternion(cameraQuaternion);
  
  // Определяем расстояние для размещения
  const distance = 1.0;
  
  // Вычисляем позицию перед камерой
  const position = new THREE.Vector3().copy(cameraPosition).add(
    direction.clone().multiplyScalar(distance)
  );
  
  // Размещаем индикатор на виртуальной "земле" (y = 0)
  position.y = 0;
  
  // Обновляем позицию индикатора
  placementIndicator.position.copy(position);
  placementIndicator.visible = true;
}

// Размещение модели в AR
function placeModelInAR() {
  if (!currentModel || !state.modelLoaded) {
    showMessage('Модель не загружена');
    return;
  }
  
  try {
    // Получаем позицию и поворот камеры
    const cameraPosition = new THREE.Vector3();
    const cameraQuaternion = new THREE.Quaternion();
    
    camera.getWorldPosition(cameraPosition);
    camera.getWorldQuaternion(cameraQuaternion);
    
    // Получаем направление взгляда
    const direction = new THREE.Vector3(0, 0, -1);
    direction.applyQuaternion(cameraQuaternion);
    
    // Определяем позицию для модели
    const distance = 1.0; // Расстояние перед камерой
    const position = new THREE.Vector3().copy(cameraPosition).add(
      direction.multiplyScalar(distance)
    );
    
    // Если мы в режиме размещения и индикатор виден, используем его позицию
    if (state.placingMode && placementIndicator && placementIndicator.visible) {
      position.copy(placementIndicator.position);
    }
    
    // Клонируем модель с помощью SkeletonUtils для корректного копирования анимаций
    const clonedModel = THREE.SkeletonUtils.clone(currentModel);
    
    // Очищаем userData от autoRotate, чтобы клонированная модель не вращалась
    clonedModel.userData = { ...currentModel.userData };
    clonedModel.userData.autoRotate = false;
    
    // Устанавливаем позицию модели
    clonedModel.position.copy(position);
    
    // Добавляем небольшое случайное смещение по Y, чтобы модель "стояла" на поверхности
    clonedModel.position.y += 0.01;
    
    // Поворачиваем модель лицом к камере, но только по оси Y
    const lookAtPos = new THREE.Vector3(cameraPosition.x, clonedModel.position.y, cameraPosition.z);
    clonedModel.lookAt(lookAtPos);
    
    // Добавляем модель в группу размещенных моделей
    placedModelsGroup.add(clonedModel);
    
    // Сохраняем информацию о размещенной модели
    const placedModelId = Date.now().toString();
    state.placedModels.push({
      id: placedModelId,
      model: clonedModel,
      modelId: state.selectedModelId
    });
    
    // Скрываем индикатор размещения
    if (placementIndicator) {
      placementIndicator.visible = false;
    }
    
    // Выключаем режим размещения
    state.placingMode = false;
    
    // Обновляем UI
    document.body.classList.remove('model-placing');
    
    // Сообщаем пользователю об успешном размещении
    showMessage('Модель размещена');
    
    return clonedModel;
  } catch (error) {
    console.error('Ошибка при размещении модели:', error);
    showMessage('Ошибка при размещении модели');
    return null;
  }
}

// Включение режима размещения
function togglePlacementMode() {
  state.placingMode = !state.placingMode;
  
  if (state.placingMode) {
    // Включаем режим размещения
    showMessage('Режим размещения активирован. Нажмите на экран для размещения модели.');
    document.body.classList.add('model-placing');
    
    // Показываем индикатор размещения
    if (placementIndicator) {
      placementIndicator.visible = true;
    }
    
    // Отключаем режим вращения, если он был включен
    state.rotatingMode = false;
  } else {
    // Выключаем режим размещения
    showMessage('Режим размещения отключен');
    document.body.classList.remove('model-placing');
    
    // Скрываем индикатор размещения
    if (placementIndicator) {
      placementIndicator.visible = false;
    }
  }
}

// Включение режима вращения
function toggleRotationMode() {
  state.rotatingMode = !state.rotatingMode;
  
  if (state.rotatingMode) {
    // Включаем режим вращения
    showMessage('Режим вращения активирован. Поворачивайте модель жестом пальца.');
    
    // Отключаем режим размещения, если он был включен
    state.placingMode = false;
    
    // Скрываем индикатор размещения
    if (placementIndicator) {
      placementIndicator.visible = false;
    }
  } else {
    // Выключаем режим вращения
    showMessage('Режим вращения отключен');
  }
}

// Сброс размещенных моделей
function resetPlacedModels() {
  // Удаляем все размещенные модели
  while (placedModelsGroup.children.length > 0) {
    placedModelsGroup.remove(placedModelsGroup.children[0]);
  }
  
  // Очищаем массив размещенных моделей
  state.placedModels = [];
  
  // Сбрасываем режимы
  state.placingMode = false;
  state.rotatingMode = false;
  
  // Скрываем индикатор размещения
  if (placementIndicator) {
    placementIndicator.visible = false;
  }
  
  showMessage('Все модели удалены');
}

// Настройка обработчиков событий
function setupEventListeners() {
  // Обработчики для карусели моделей
  elements.modelItems.forEach((item, index) => {
    item.addEventListener('click', () => {
      // Определяем ID модели из data-атрибута
      const modelPath = item.dataset.model;
      const modelId = modelPath.includes('cat.glb') ? 'cat' : 
                      modelPath.includes('model.glb') ? 'chair' : 
                      modelPath.includes('apple.glb') ? 'apple' : 'cat';
      
      // Обновляем активный элемент
      elements.modelItems.forEach(el => el.classList.remove('active'));
      item.classList.add('active');
      
      // Обновляем индекс текущей модели
      state.currentModelIndex = index;
      
      // Загружаем модель
      loadModel(modelId);
    });
    
    // Обработчики для долгого нажатия
    item.addEventListener('touchstart', handleTouchStart);
    item.addEventListener('touchend', handleTouchEnd);
    item.addEventListener('mousedown', handleTouchStart);
    item.addEventListener('mouseup', handleTouchEnd);
  });
  
  // Обработчик для кнопки размещения
  elements.placeButton.addEventListener('click', () => {
    if (state.modelLoaded) {
      if (state.placingMode) {
        // Если режим размещения уже активирован, разместить модель
        placeModelInAR();
      } else {
        // Включить режим размещения
        togglePlacementMode();
      }
    }
  });
  
  // Обработчик для кнопки вращения
  elements.rotateButton.addEventListener('click', () => {
    if (state.modelLoaded) {
      toggleRotationMode();
    }
  });
  
  // Обработчик для кнопки сброса
  elements.resetButton.addEventListener('click', resetPlacedModels);
  
  // Обработчик для клика на сцене (для взаимодействия с кнопками на модели)
  elements.arContainer.addEventListener('click', handleSceneClick);
  
  // Обработчики для жестов вращения
  elements.arContainer.addEventListener('touchstart', handleRotateTouchStart);
  elements.arContainer.addEventListener('touchmove', handleRotateTouchMove);
  elements.arContainer.addEventListener('touchend', handleRotateTouchEnd);
  
  // Обработчик для переключения режима AR
  elements.arContainer.addEventListener('touchstart', handleARModeTouchStart);
  elements.arContainer.addEventListener('touchend', handleARModeTouchEnd);
  
  // Обработчик для размещения модели при клике в режиме размещения
  elements.arContainer.addEventListener('click', (event) => {
    if (state.placingMode && state.modelLoaded) {
      placeModelInAR();
    }
  });
  
  // Обработчик изменения размера окна
  window.addEventListener('resize', () => {
    if (mindarThree && mindarThree.renderer) {
      const width = window.innerWidth;
      const height = window.innerHeight;
      mindarThree.renderer.setSize(width, height);
    }
  });
}

// Обработчики долгого нажатия на миниатюры моделей
function handleTouchStart(event) {
  state.touchStartTime = Date.now();
}

function handleTouchEnd(event) {
  const touchDuration = Date.now() - state.touchStartTime;
  
  // Если было долгое нажатие, переходим в режим AR
  if (touchDuration >= state.longPressThreshold) {
    if (state.modelLoaded) {
      toggleARMode();
    }
  }
}

// Переключение режима AR
function toggleARMode() {
  state.arMode = !state.arMode;
  
  if (state.arMode) {
    document.body.classList.add('ar-active');
    elements.arModeIndicator.classList.remove('hidden');
    showMessage('Режим AR активирован. Удерживайте палец на модели для взаимодействия.');
  } else {
    document.body.classList.remove('ar-active');
    elements.arModeIndicator.classList.add('hidden');
    showMessage('Режим AR деактивирован');
  }
}

// Обработчики касания для режима AR
function handleARModeTouchStart(event) {
  if (!currentModel || !state.modelLoaded) return;
  
  state.touchStartTime = Date.now();
  state.touchingModel = false;
  
  // Определяем, было ли нажатие на модель
  const touch = event.touches ? event.touches[0] : event;
  mouse.x = (touch.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(touch.clientY / window.innerHeight) * 2 + 1;
  
  raycaster.setFromCamera(mouse, camera);
  
  const allModels = [currentModel, ...state.placedModels.map(item => item.model)];
  
  for (const model of allModels) {
    if (!model) continue;
    
    const intersects = raycaster.intersectObject(model, true);
    
    if (intersects.length > 0) {
      state.touchingModel = true;
      state.selectedObject = model;
      break;
    }
  }
}

function handleARModeTouchEnd(event) {
  if (!state.touchingModel) return;
  
  const touchDuration = Date.now() - state.touchStartTime;
  
  // Если это долгое нажатие на модель, переключаем режим AR
  if (touchDuration >= state.longPressThreshold) {
    toggleARMode();
  }
  
  state.touchingModel = false;
  state.selectedObject = null;
}

// Обработчики для вращения модели жестами
let rotateStartPoint = { x: 0, y: 0 };
let rotateDelta = { x: 0, y: 0 };
let isRotating = false;

function handleRotateTouchStart(event) {
  if (!state.rotatingMode || !currentModel) return;
  
  const touch = event.touches ? event.touches[0] : event;
  rotateStartPoint = { 
    x: touch.clientX, 
    y: touch.clientY 
  };
  
  isRotating = true;
}

function handleRotateTouchMove(event) {
  if (!isRotating || !state.rotatingMode || !currentModel) return;
  
  const touch = event.touches ? event.touches[0] : event;
  
  // Вычисляем смещение
  rotateDelta = {
    x: touch.clientX - rotateStartPoint.x,
    y: touch.clientY - rotateStartPoint.y
  };
  
  // Вращаем модель
  currentModel.rotation.y += rotateDelta.x * 0.01;
  currentModel.rotation.x += rotateDelta.y * 0.01;
  
  // Обновляем начальную точку
  rotateStartPoint = { 
    x: touch.clientX, 
    y: touch.clientY 
  };
}

function handleRotateTouchEnd(event) {
  isRotating = false;
}

// Обработчик клика на сцене (для взаимодействия с кнопками на модели)
function handleSceneClick(event) {
  // Получаем координаты клика
  mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
  
  // Создаем Raycaster
  raycaster.setFromCamera(mouse, camera);
  
  // Проверяем пересечение со всеми моделями в сцене
  const allModels = [currentModel, ...state.placedModels.map(item => item.model)];
  
  for (const model of allModels) {
    if (!model) continue;
    
    const intersects = raycaster.intersectObject(model, true);
    
    if (intersects.length > 0) {
      const object = intersects[0].object;
      
      // Проверяем, является ли объект кнопкой
      let button = null;
      let current = object;
      
      while (current && !button) {
        if (current.userData && current.userData.type === 'button') {
          button = current;
        }
        current = current.parent;
      }
      
      if (button) {
        handleButtonClick(button.userData.action);
      }
      
      break;
    }
  }
}

// Обработчик клика на кнопки модели
function handleButtonClick(action) {
  switch (action) {
    case 'www':
      window.open('https://www.alphawood.store', '_blank');
      showMessage('Открывается веб-сайт...');
      break;
    case 'email':
      window.location.href = 'mailto:info@alphawood.store';
      showMessage('Открывается почтовый клиент...');
      break;
    default:
      break;
  }
}

// Показать сообщение
function showMessage(message) {
  elements.arMessage.textContent = message;
  elements.arMessage.classList.remove('hidden');
  
  // Автоматически скрываем сообщение через 3 секунды
  clearTimeout(elements.arMessage.hideTimeout);
  elements.arMessage.hideTimeout = setTimeout(() => {
    elements.arMessage.classList.add('hidden');
  }, 3000);
}

// Скрыть экран загрузки
function hideLoading() {
  elements.loadingScreen.classList.add('hidden');
  state.isLoading = false;
}

// Остановка AR
function stopAR() {
  if (mindarThree) {
    mindarThree.stop();
    renderer.setAnimationLoop(null);
  } else if (video && video.srcObject) {
    // Останавливаем видеопоток, если используем ручную инициализацию камеры
    const tracks = video.srcObject.getTracks();
    tracks.forEach(track => track.stop());
    video.srcObject = null;
    renderer.setAnimationLoop(null);
  }
}

// Обработчик при закрытии страницы
window.addEventListener('beforeunload', () => {
  stopAR();
});

// Инициализация приложения при загрузке страницы
// Запускаем инициализацию сразу, без задержки
window.addEventListener('load', () => {
  // Запрашиваем разрешение на использование камеры немедленно
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
      .then(function(stream) {
        // После получения доступа к камере запускаем приложение
        setTimeout(initApp, 100);
      })
      .catch(function(error) {
        console.error('Ошибка доступа к камере:', error);
        // Всё равно пытаемся запустить приложение
        initApp();
      });
  } else {
    initApp();
  }
}); 