import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import NativeFullHeapPost from './specs/NativeFullHeapPost';

type Scenario = {
  readonly label: string;
  readonly fillJavaHeap: boolean;
  readonly attachThreadFirst: boolean;
};

const scenarios: readonly Scenario[] = [
  {
    label: 'Post with the Java heap free',
    fillJavaHeap: false,
    attachThreadFirst: false,
  },
  {
    label: 'Post from a new thread with the Java heap full',
    fillJavaHeap: true,
    attachThreadFirst: false,
  },
  {
    label: 'Post from an attached thread with the Java heap full',
    fillJavaHeap: true,
    attachThreadFirst: true,
  },
];

function App() {
  const [status, setStatus] = useState('Tap a button once per launch');

  const start = (scenario: Scenario) => {
    NativeFullHeapPost.postFromOwnThread(
      scenario.fillJavaHeap,
      scenario.attachThreadFirst,
      () => {
        NativeFullHeapPost.release();
        setStatus(`${scenario.label}: the posted callback ran`);
      },
    );
  };

  return (
    <View style={styles.container}>
      {scenarios.map(scenario => (
        <Pressable
          key={scenario.label}
          accessibilityRole="button"
          accessibilityLabel={scenario.label}
          onPress={() => start(scenario)}
          style={styles.button}
        >
          <Text style={styles.buttonText}>{scenario.label}</Text>
        </Pressable>
      ))}
      <Text accessibilityLabel={status} style={styles.status}>
        {status}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
    gap: 16,
    backgroundColor: 'white',
  },
  button: {
    padding: 16,
    borderRadius: 8,
    backgroundColor: '#1f6feb',
  },
  buttonText: {
    color: 'white',
    fontSize: 16,
  },
  status: {
    fontSize: 16,
    color: 'black',
  },
});

export default App;
