const int knobCount = 4;
const uint8_t knobPins[knobCount] = {A0, A1, A2, A3};

int knobValues[knobCount] = {0};
bool knobActive[knobCount] = {false};

void setup() {
  Serial.begin(9600);

  for (int i = 0; i < knobCount; i++) {
    bindToSoftware(knobPins[i], i + 1);
  }
}

void loop() {
  for (int i = 0; i < knobCount; i++) {
    knobValues[i] = checkKnob(knobPins[i], knobValues[i], i);
  }
}

int checkKnob(uint8_t pin, int prevVal, int index) {
  int val = map(readAverage(pin), 0, 1024, 0, 100);
  if (val > 98) val = 100;
  if (val < 2) val = 0;
  int delta = abs(val - prevVal);

  if (!knobActive[index]) {
    if (delta > 1) {
      knobActive[index] = true;  // Activate knob
    }
  } else {
    if (delta > 2) {
      sendUpdate(val, index + 1);
      return val;
    } else {
      knobActive[index] = false; // Deactivate
    }
  }

  return prevVal;
}

void sendUpdate(int val, int ID) {
  Serial.print(val);
  Serial.print("@");
  Serial.print(ID);
  Serial.print("\n");
}

int readAverage(uint8_t pin) {
  long total = 0;
  for (int i = 0; i < 5; i++) {
    total += analogRead(pin);
  }
  return total / 5;
}

void bindToSoftware(uint8_t pin, int ID) {
  int initialValue = map(analogRead(pin), 0, 1024, 0, 100);
  if (initialValue > 98) initialValue = 100;
  Serial.print(initialValue);
  Serial.print("@");
  Serial.print(ID);
  Serial.print("\n");
}
