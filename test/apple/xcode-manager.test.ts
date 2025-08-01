import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PBXNativeTarget,
  PBXShellScriptBuildPhase,
  XCBuildConfiguration,
} from 'xcode';
import { getRunScriptTemplate } from '../../src/apple/templates';
import { XcodeProject } from '../../src/apple/xcode-manager';
import type { SentryProjectData } from '../../src/utils/types';

vi.mock('node:fs', async () => ({
  __esModule: true,
  ...(await vi.importActual<typeof fs>('node:fs')),
}));

vi.mock('@clack/prompts', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    step: vi.fn(),
  },
}));

const appleProjectsPath = path.resolve(
  __dirname,
  '../../fixtures/test-applications/apple',
);
const damagedProjectPath = path.join(
  appleProjectsPath,
  'damaged-missing-configuration-list/Project.xcodeproj/project.pbxproj',
);
const noTargetsProjectPath = path.join(
  appleProjectsPath,
  'no-targets/Project.xcodeproj/project.pbxproj',
);
const noFilesInTargetProjectPath = path.join(
  appleProjectsPath,
  'no-files-in-target/Project.xcodeproj/project.pbxproj',
);
const projectWithSynchronizedFolders = path.join(
  appleProjectsPath,
  'project-with-synchronized-folders/Project.xcodeproj/project.pbxproj',
);
const singleTargetProjectPath = path.join(
  appleProjectsPath,
  'spm-swiftui-single-target/Project.xcodeproj/project.pbxproj',
);
const multiTargetProjectPath = path.join(
  appleProjectsPath,
  'spm-swiftui-multi-targets/Project.xcodeproj/project.pbxproj',
);
const projectData: SentryProjectData = {
  id: '1234567890',
  slug: 'project',
  organization: {
    id: '1234567890',
    name: 'Sentry',
    slug: 'sentry',
  },
  keys: [{ dsn: { public: 'https://sentry.io/1234567890' } }],
};

describe('XcodeManager', () => {
  beforeEach(() => {
    if (process.platform !== 'darwin') {
      // The macOS system helpers are only available on macOS
      // As the test suite is also run on non-macOS platforms, we need to mock the system helpers

      // The path to the Xcode.app can be different on different machines, so we allow overwriting it using environment variables
      vi.mock('../../src/apple/macos-system-helper', () => ({
        MacOSSystemHelpers: {
          findSDKRootDirectoryPath: vi.fn(
            () =>
              '/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk',
          ),
          findDeveloperDirectoryPath: vi.fn(
            () => '/Applications/Xcode.app/Contents/Developer',
          ),
          readXcodeBuildSettings: vi.fn(() => ({
            CONFIGURATION_BUILD_DIR: path.join(
              appleProjectsPath,
              'project-with-synchronized-folders/build/Release-unknown',
            ),
          })),
        },
      }));
    }
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('XcodeProject', () => {
    describe('getAllTargets', () => {
      describe('single target', () => {
        it('should return all targets', () => {
          // -- Arrange --
          const xcodeProject = new XcodeProject(singleTargetProjectPath);

          // -- Act --
          const targets = xcodeProject.getAllTargets();

          // -- Assert --
          expect(targets).toEqual(['Project']);
        });
      });

      describe('multiple targets', () => {
        it('should return all targets', () => {
          // -- Arrange --
          const xcodeProject = new XcodeProject(multiTargetProjectPath);

          // -- Act --
          const targets = xcodeProject.getAllTargets();

          // -- Assert --
          expect(targets).toEqual(['Project1', 'Project2']);
        });
      });

      describe('no targets', () => {
        it('should return an empty array', () => {
          // -- Arrange --
          const xcodeProject = new XcodeProject(noTargetsProjectPath);

          // -- Act --
          const targets = xcodeProject.getAllTargets();

          // -- Assert --
          expect(targets).toEqual([]);
        });
      });

      describe('project with missing configuration list', () => {
        it('should return an empty array', () => {
          // -- Arrange --
          const xcodeProject = new XcodeProject(damagedProjectPath);

          // -- Act --
          const targets = xcodeProject.getAllTargets();

          // -- Assert --
          expect(targets).toEqual([]);
        });
      });
    });

    describe('updateXcodeProject', () => {
      let sourceProjectPath: string;
      let tempProjectPath: string;
      let xcodeProject: XcodeProject;

      beforeEach(() => {
        const tempDir = fs.mkdtempSync(
          path.join(os.tmpdir(), 'update-xcode-project'),
        );

        sourceProjectPath = singleTargetProjectPath;
        tempProjectPath = path.resolve(tempDir, 'project.pbxproj');

        fs.copyFileSync(sourceProjectPath, tempProjectPath);
        xcodeProject = new XcodeProject(tempProjectPath);
      });

      describe('upload symbols script', () => {
        const scriptVariants: {
          uploadSource: boolean;
          includeHomebrewPath: boolean;
        }[] = [
          {
            uploadSource: true,
            includeHomebrewPath: true,
          },
          {
            uploadSource: true,
            includeHomebrewPath: false,
          },
          {
            uploadSource: false,
            includeHomebrewPath: true,
          },
          {
            uploadSource: false,
            includeHomebrewPath: false,
          },
        ];

        for (const variant of scriptVariants) {
          describe(`upload source = ${variant.uploadSource?.toString()} and include homebrew path = ${variant.includeHomebrewPath.toString()}`, () => {
            beforeEach(() => {
              vi.spyOn(fs, 'existsSync').mockReturnValue(
                variant.includeHomebrewPath,
              );
            });

            afterEach(() => {
              vi.restoreAllMocks();
            });

            it('should add the upload symbols script to the target', () => {
              // -- Arrange --
              const generatedShellScript = getRunScriptTemplate(
                projectData.organization.slug,
                projectData.slug,
                variant.uploadSource,
                variant.includeHomebrewPath,
              );
              const expectedShellScript = `"${generatedShellScript.replace(
                /"/g,
                '\\"',
              )}"`;

              // -- Act --
              xcodeProject.updateXcodeProject(
                projectData,
                'Project',
                false, // Ignore SPM reference
                variant.uploadSource,
              );

              // -- Assert --
              const updatedXcodeProject = new XcodeProject(tempProjectPath);

              // Expect the upload symbols script to be added
              const scriptObjects =
                updatedXcodeProject.objects.PBXShellScriptBuildPhase;
              expect(scriptObjects).toBeDefined();
              if (!scriptObjects) {
                throw new Error('Script objects not found');
              }
              const scriptKeys = Object.keys(scriptObjects);
              expect(scriptKeys).toHaveLength(2);

              // Find the script ID
              const scriptId = scriptKeys.find(
                (key) => !key.endsWith('_comment'),
              );
              expect(scriptId).toBeDefined();
              if (!scriptId) {
                throw new Error('Script ID not found');
              }
              expect(scriptId).toMatch(/^[A-F0-9]{24}$/i);

              // Expect the script to be added
              const script = scriptObjects[
                scriptId
              ] as PBXShellScriptBuildPhase;
              expect(script).toBeDefined();
              expect(typeof script).not.toBe('string');
              expect(script.inputPaths).toEqual([
                '"${DWARF_DSYM_FOLDER_PATH}/${DWARF_DSYM_FILE_NAME}/Contents/Resources/DWARF/${TARGET_NAME}"',
              ]);
              expect(script.outputPaths).toEqual([]);
              expect(script.shellPath).toBe('/bin/sh');
              expect(script.shellScript).toEqual(expectedShellScript);

              const commentKey = `${scriptId}_comment`;
              expect(scriptKeys).toContain(commentKey);
              expect(scriptObjects[commentKey]).toBe(
                'Upload Debug Symbols to Sentry',
              );
            });
          });
        }
      });

      describe('debug information format and sandbox', () => {
        describe('upload source is false', () => {
          it('should not update the Xcode project', () => {
            // -- Act --
            xcodeProject.updateXcodeProject(
              projectData,
              'Project',
              false, // Ignore SPM reference
              false,
            );

            // -- Assert --
            const expectedXcodeProject = new XcodeProject(sourceProjectPath);
            expect(xcodeProject.objects.XCBuildConfiguration).toEqual(
              expectedXcodeProject.objects.XCBuildConfiguration,
            );
          });
        });

        describe('upload source is true', () => {
          const uploadSource = true;

          describe('named target not found', () => {
            it('should not update the flags in the Xcode project', () => {
              // -- Act --
              xcodeProject.updateXcodeProject(
                projectData,
                'Invalid Target Name',
                false, // Ignore SPM reference
                uploadSource,
              );

              // -- Assert --
              const originalXcodeProject = new XcodeProject(sourceProjectPath);
              expect(xcodeProject.objects.XCBuildConfiguration).toEqual(
                originalXcodeProject.objects.XCBuildConfiguration,
              );
            });
          });

          describe('named target found', () => {
            describe('build configurations is undefined', () => {
              it('should not update the Xcode project', () => {
                // -- Act --
                xcodeProject.updateXcodeProject(
                  projectData,
                  'Invalid Target Name',
                  false, // Ignore SPM reference
                  uploadSource,
                );

                // -- Assert --
                const originalXcodeProject = new XcodeProject(
                  sourceProjectPath,
                );
                expect(xcodeProject.objects.XCBuildConfiguration).toEqual(
                  originalXcodeProject.objects.XCBuildConfiguration,
                );
              });
            });

            describe('no build configurations found', () => {
              it('should not update the Xcode project', () => {
                // -- Arrange --
                xcodeProject.objects.XCBuildConfiguration = {};

                // -- Act --
                xcodeProject.updateXcodeProject(
                  projectData,
                  'Invalid Target Name',
                  false, // Ignore SPM reference
                  uploadSource,
                );

                // -- Assert --
                expect(xcodeProject.objects.XCBuildConfiguration).toEqual({});
              });
            });

            describe('build configurations found', () => {
              const debugProjectBuildConfigurationListId =
                'D4E604DA2D50CEEE00CAB00F';
              const releaseProjectBuildConfigurationListId =
                'D4E604DB2D50CEEE00CAB00F';
              const debugTargetBuildConfigurationListId =
                'D4E604DD2D50CEEE00CAB00F';
              const releaseTargetBuildConfigurationListId =
                'D4E604DE2D50CEEE00CAB00F';

              it('should update the target configuration lists', () => {
                // -- Act --
                xcodeProject.updateXcodeProject(
                  projectData,
                  'Project',
                  false, // Ignore SPM reference
                  uploadSource,
                );

                // -- Assert --
                expect(xcodeProject.objects.XCBuildConfiguration).toBeDefined();
                // Both Debug and Release are configured equally
                const expectedConfigKeys = [
                  debugTargetBuildConfigurationListId, // Debug
                  releaseTargetBuildConfigurationListId, // Release
                ];
                for (const key of expectedConfigKeys) {
                  const buildConfiguration = xcodeProject.objects
                    .XCBuildConfiguration?.[key] as XCBuildConfiguration;
                  expect(buildConfiguration).toBeDefined();
                  expect(typeof buildConfiguration).not.toBe('string');
                  const buildSettings = buildConfiguration.buildSettings ?? {};
                  expect(buildSettings.DEBUG_INFORMATION_FORMAT).toBe(
                    '"dwarf-with-dsym"',
                  );
                  expect(buildSettings.ENABLE_USER_SCRIPT_SANDBOXING).toBe(
                    '"NO"',
                  );
                }
              });

              it('should not update the project configuration lists', () => {
                // -- Act --
                xcodeProject.updateXcodeProject(
                  projectData,
                  'Project',
                  false, // Ignore SPM reference
                  uploadSource,
                );

                // -- Assert --
                expect(xcodeProject.objects.XCBuildConfiguration).toBeDefined();

                // Check project build configurations 'Debug'
                const debugBuildConfiguration = xcodeProject.objects
                  .XCBuildConfiguration?.[
                  debugProjectBuildConfigurationListId
                ] as XCBuildConfiguration;
                expect(debugBuildConfiguration).toBeDefined();
                expect(typeof debugBuildConfiguration).not.toBe('string');
                expect(
                  debugBuildConfiguration.buildSettings
                    ?.DEBUG_INFORMATION_FORMAT,
                ).toBe('dwarf');
                expect(
                  debugBuildConfiguration.buildSettings
                    ?.ENABLE_USER_SCRIPT_SANDBOXING,
                ).toBe('YES');

                // Check project build configurations 'Release'
                const releaseBuildConfiguration = xcodeProject.objects
                  .XCBuildConfiguration?.[
                  releaseProjectBuildConfigurationListId
                ] as XCBuildConfiguration;
                expect(releaseBuildConfiguration).toBeDefined();
                expect(typeof releaseBuildConfiguration).not.toBe('string');
                expect(
                  releaseBuildConfiguration.buildSettings
                    ?.DEBUG_INFORMATION_FORMAT,
                ).toBe('"dwarf-with-dsym"');
                expect(
                  releaseBuildConfiguration.buildSettings
                    ?.ENABLE_USER_SCRIPT_SANDBOXING,
                ).toBe('YES');
              });
            });
          });
        });
      });

      describe('add SPM reference', () => {
        const addSPMReference = true;

        describe('framework build phase already contains Sentry', () => {
          it('should not update the Xcode project', () => {
            // -- Arrange --
            xcodeProject.objects.PBXFrameworksBuildPhase = {
              'framework-id': {
                isa: 'PBXFrameworksBuildPhase',
                files: [
                  {
                    value: '123',
                    comment: 'Sentry in Frameworks',
                  },
                ],
              },
            };

            // -- Act --
            xcodeProject.updateXcodeProject(
              projectData,
              'Project',
              addSPMReference,
            );

            // -- Assert --
            const expectedXcodeProject = new XcodeProject(sourceProjectPath);
            expectedXcodeProject.objects.PBXFrameworksBuildPhase = {
              'framework-id': {
                isa: 'PBXFrameworksBuildPhase',
                files: [
                  {
                    value: '123',
                    comment: 'Sentry in Frameworks',
                  },
                ],
              },
            };
            expect(xcodeProject.objects.PBXFrameworksBuildPhase).toEqual(
              expectedXcodeProject.objects.PBXFrameworksBuildPhase,
            );
            expect(xcodeProject.objects.XCRemoteSwiftPackageReference).toEqual(
              expectedXcodeProject.objects.XCRemoteSwiftPackageReference,
            );
            expect(
              xcodeProject.objects.XCSwiftPackageProductDependency,
            ).toEqual(
              expectedXcodeProject.objects.XCSwiftPackageProductDependency,
            );
          });
        });

        it('should add the SPM reference to the target', () => {
          // -- Act --
          xcodeProject.updateXcodeProject(
            projectData,
            'Project',
            addSPMReference,
          );

          // -- Assert --
          // Get the target
          const target = xcodeProject.objects.PBXNativeTarget?.[
            'D4E604CC2D50CEEC00CAB00F'
          ] as PBXNativeTarget;
          expect(target).toBeDefined();
          if (!target) {
            throw new Error('Target is undefined');
          }

          // Check the SPM dependency is added to the target
          expect(target.packageProductDependencies).toEqual([
            expect.objectContaining({
              value: expect.any(String) as string,
              comment: 'Sentry',
            }),
          ]);

          // Check the SPM package reference object is added to the project
          const remoteSwiftPackageReferences =
            xcodeProject.objects.XCRemoteSwiftPackageReference;
          expect(remoteSwiftPackageReferences).toBeDefined();
          if (!remoteSwiftPackageReferences) {
            throw new Error('XCRemoteSwiftPackageReference is undefined');
          }
          const rspRefKeys = Object.keys(remoteSwiftPackageReferences);
          expect(rspRefKeys).toHaveLength(2);
          // First key is expected to be the UUID of the SPM package reference
          expect(rspRefKeys[0]).toMatch(/^[A-F0-9]{24}$/i);
          // Second key is expected to be the UUID of the SPM package reference with _comment suffix
          expect(rspRefKeys[1]).toMatch(/^[A-F0-9]{24}_comment$/i);

          expect(remoteSwiftPackageReferences?.[rspRefKeys[0]]).toEqual({
            isa: 'XCRemoteSwiftPackageReference',
            repositoryURL: '"https://github.com/getsentry/sentry-cocoa/"',
            requirement: {
              kind: 'upToNextMajorVersion',
              minimumVersion: '8.0.0',
            },
          });
          expect(remoteSwiftPackageReferences?.[rspRefKeys[1]]).toBe(
            'XCRemoteSwiftPackageReference "sentry-cocoa"',
          );

          // Check the SPM package is a dependency of the target
          const packageProductDependencies =
            xcodeProject.objects.XCSwiftPackageProductDependency;
          expect(packageProductDependencies).toBeDefined();
          if (!packageProductDependencies) {
            throw new Error('XCSwiftPackageProductDependency is undefined');
          }
          const ppDepKeys = Object.keys(packageProductDependencies);
          expect(ppDepKeys).toHaveLength(2);
          // First key is expected to be the UUID of the SPM package dependency
          expect(ppDepKeys[0]).toMatch(/^[A-F0-9]{24}$/i);
          // Second key is expected to be the UUID of the SPM package dependency with _comment suffix
          expect(ppDepKeys[1]).toMatch(/^[A-F0-9]{24}_comment$/i);
          expect(packageProductDependencies?.[ppDepKeys[0]]).toEqual({
            isa: 'XCSwiftPackageProductDependency',
            package: rspRefKeys[0],
            package_comment: 'XCRemoteSwiftPackageReference "sentry-cocoa"',
            productName: 'Sentry',
          });
        });

        it('should initialize packageProductDependencies if not present', () => {
          // -- Arrange --
          // Ensure the target exists but has no packageProductDependencies initially
          const targetKey = 'D4E604CC2D50CEEC00CAB00F';
          const target = xcodeProject.objects.PBXNativeTarget?.[
            targetKey
          ] as PBXNativeTarget;
          if (target) {
            // Remove packageProductDependencies to test initialization
            delete target.packageProductDependencies;
          }

          // -- Act --
          xcodeProject.updateXcodeProject(
            projectData,
            'Project',
            addSPMReference,
          );

          // -- Assert --
          const updatedTarget = xcodeProject.objects.PBXNativeTarget?.[
            targetKey
          ] as PBXNativeTarget;
          expect(updatedTarget.packageProductDependencies).toBeDefined();
          expect(updatedTarget.packageProductDependencies).toEqual([
            expect.objectContaining({
              value: expect.any(String) as string,
              comment: 'Sentry',
            }),
          ]);
        });
      });
    });

    describe('getSourceFilesForTarget', () => {
      describe('targets are undefined', () => {
        it('should return undefined', () => {
          // -- Arrange --
          const xcodeProject = new XcodeProject(singleTargetProjectPath);
          xcodeProject.objects.PBXNativeTarget = undefined;

          // -- Act --
          const files = xcodeProject.getSourceFilesForTarget('Project');

          // -- Assert --
          expect(files).toBeUndefined();
        });
      });

      describe('target not found', () => {
        it('should return undefined', () => {
          // -- Arrange --
          const xcodeProject = new XcodeProject(singleTargetProjectPath);

          // -- Act --
          const files =
            xcodeProject.getSourceFilesForTarget('NonExistentTarget');

          // -- Assert --
          expect(files).toBeUndefined();
        });
      });

      describe('target build phases are undefined', () => {
        it('should return empty array', () => {
          // -- Arrange --
          const xcodeProject = new XcodeProject(singleTargetProjectPath);
          xcodeProject.objects.PBXNativeTarget = {
            Project: {
              isa: 'PBXNativeTarget',
              name: 'Project',
              buildPhases: undefined,
            },
          };

          // -- Act --
          const files = xcodeProject.getSourceFilesForTarget('Project');

          // -- Assert --
          expect(files).toEqual([]);
        });
      });

      describe('build phases are undefined', () => {
        it('should return empty array', () => {
          // -- Arrange --
          const xcodeProject = new XcodeProject(singleTargetProjectPath);
          xcodeProject.objects.PBXNativeTarget = {
            Project: {
              isa: 'PBXNativeTarget',
              name: 'Project',
              buildPhases: undefined,
            },
          };
          xcodeProject.objects.PBXSourcesBuildPhase = undefined;

          // -- Act --
          const files = xcodeProject.getSourceFilesForTarget('Project');

          // -- Assert --
          expect(files).toEqual([]);
        });
      });

      describe('referenced build phase is undefined', () => {
        it('should return empty array', () => {
          // -- Arrange --
          const xcodeProject = new XcodeProject(singleTargetProjectPath);
          xcodeProject.objects.PBXNativeTarget = {
            Project: {
              isa: 'PBXNativeTarget',
              name: 'Project',
              buildPhases: [
                {
                  value: 'random-build-phase',
                },
              ],
            },
          };

          // -- Act --
          const files = xcodeProject.getSourceFilesForTarget('Project');

          // -- Assert --
          expect(files).toEqual([]);
        });
      });

      describe('build phase files are undefined', () => {
        it('should return empty array', () => {
          // -- Arrange --
          const xcodeProject = new XcodeProject(singleTargetProjectPath);
          xcodeProject.objects.PBXNativeTarget = {
            Project: {
              isa: 'PBXNativeTarget',
              name: 'Project',
              buildPhases: [
                {
                  value: 'build-phase-key',
                },
              ],
            },
          };
          xcodeProject.objects.PBXSourcesBuildPhase = {
            'build-phase-key': {
              isa: 'PBXSourcesBuildPhase',
              files: undefined,
            },
          };

          // -- Act --
          const files = xcodeProject.getSourceFilesForTarget('Project');

          // -- Assert --
          expect(files).toEqual([]);
        });
      });

      describe('build phase has no files', () => {
        it('should return empty array', () => {
          // -- Arrange --
          const xcodeProject = new XcodeProject(noFilesInTargetProjectPath);

          // -- Act --
          const files = xcodeProject.getSourceFilesForTarget('Project');

          // -- Assert --
          expect(files).toEqual([]);
        });
      });

      describe('build phase with files', () => {
        let xcodeProject: XcodeProject;

        beforeEach(() => {
          xcodeProject = new XcodeProject(singleTargetProjectPath);
          xcodeProject.objects.PBXNativeTarget = {
            'some-target': {
              isa: 'PBXNativeTarget',
              name: 'some-target',
              buildPhases: [
                {
                  value: 'build-phase-key',
                },
              ],
            },
          };
          xcodeProject.objects.PBXSourcesBuildPhase = {
            'build-phase-key': {
              isa: 'PBXSourcesBuildPhase',
              files: [
                {
                  value: 'file-key',
                },
              ],
            },
          };
          xcodeProject.objects.PBXBuildFile = {
            'file-key': {
              isa: 'PBXBuildFile',
              fileRef: 'file-ref-key',
            },
          };
        });

        describe('build file objects are not defined', () => {
          it('should return empty array', () => {
            // -- Arrange --
            xcodeProject.objects.PBXBuildFile = undefined;

            // -- Act --
            const files = xcodeProject.getSourceFilesForTarget('some-target');

            // -- Assert --
            expect(files).toEqual([]);
          });
        });

        describe('build file object is not found', () => {
          it('should return empty array', () => {
            // -- Arrange --
            xcodeProject.objects.PBXBuildFile = {};

            // -- Act --
            const files = xcodeProject.getSourceFilesForTarget('some-target');

            // -- Assert --
            expect(files).toEqual([]);
          });
        });

        describe('build file object is invalid', () => {
          it('should return empty array', () => {
            // -- Arrange --
            xcodeProject.objects.PBXBuildFile = {
              'file-key': 'invalid-object',
            };

            // -- Act --
            const files = xcodeProject.getSourceFilesForTarget('some-target');

            // -- Assert --
            expect(files).toEqual([]);
          });
        });

        describe('file reference is missing', () => {
          it('should return empty array', () => {
            // -- Arrange --
            xcodeProject.objects.PBXBuildFile = {
              'file-key': {
                isa: 'PBXBuildFile',
              },
            };

            // -- Act --
            const files = xcodeProject.getSourceFilesForTarget('some-target');

            // -- Assert --
            expect(files).toEqual([]);
          });
        });

        describe('file reference is invalid', () => {
          it('should return empty array', () => {
            // -- Arrange --
            xcodeProject.objects.PBXFileReference = {
              'file-ref-key': 'invalid-object',
            };

            // -- Act --
            const files = xcodeProject.getSourceFilesForTarget('some-target');

            // -- Assert --
            expect(files).toEqual([]);
          });
        });

        describe('file reference path is missing', () => {
          it('should return empty array', () => {
            // -- Arrange --
            xcodeProject.objects.PBXFileReference = {
              'file-ref-key': {
                isa: 'PBXFileReference',
                path: undefined as unknown as string,
                sourceTree: 'SOURCE_ROOT',
              },
            };

            // -- Act --
            const files = xcodeProject.getSourceFilesForTarget('some-target');

            // -- Assert --
            expect(files).toEqual([]);
          });
        });

        describe('valid file reference', () => {
          it('should return array with file path', () => {
            // -- Arrange --
            xcodeProject.objects.PBXFileReference = {
              'file-ref-key': {
                isa: 'PBXFileReference',
                path: 'test.swift',
                sourceTree: 'SOURCE_ROOT',
              },
            };

            // -- Act --
            const files = xcodeProject.getSourceFilesForTarget('some-target');

            // -- Assert --
            expect(files).toEqual([
              path.join(xcodeProject.baseDir, 'test.swift'),
            ]);
          });
        });
      });

      describe('synchronized root groups', () => {
        it('should handle missing fileSystemSynchronizedGroups', () => {
          // -- Arrange --
          const xcodeProject = new XcodeProject(singleTargetProjectPath);
          xcodeProject.objects.PBXNativeTarget = {
            'some-target': {
              isa: 'PBXNativeTarget',
              name: 'some-target',
            },
          };

          // -- Act --
          const files = xcodeProject.getSourceFilesForTarget('some-target');

          // -- Assert --
          expect(files).toEqual([]);
        });

        it('should handle empty fileSystemSynchronizedGroups', () => {
          // -- Arrange --
          const xcodeProject = new XcodeProject(singleTargetProjectPath);
          xcodeProject.objects.PBXNativeTarget = {
            'some-target': {
              isa: 'PBXNativeTarget',
              name: 'some-target',
              fileSystemSynchronizedGroups: [],
            },
          };

          // -- Act --
          const files = xcodeProject.getSourceFilesForTarget('some-target');

          // -- Assert --
          expect(files).toEqual([]);
        });

        it('should handle invalid synchronized root group', () => {
          // -- Arrange --
          const xcodeProject = new XcodeProject(singleTargetProjectPath);
          xcodeProject.objects.PBXNativeTarget = {
            'some-target': {
              isa: 'PBXNativeTarget',
              name: 'some-target',
              fileSystemSynchronizedGroups: [
                {
                  value: 'invalid-group',
                },
              ],
            },
          };

          // -- Act --
          const files = xcodeProject.getSourceFilesForTarget('some-target');

          // -- Assert --
          expect(files).toEqual([]);
        });

        it('should handle synchronized root group with missing path', () => {
          // -- Arrange --
          const xcodeProject = new XcodeProject(singleTargetProjectPath);
          xcodeProject.objects.PBXNativeTarget = {
            'some-target': {
              isa: 'PBXNativeTarget',
              name: 'some-target',
              fileSystemSynchronizedGroups: [
                {
                  value: 'group-key',
                },
              ],
            },
          };
          xcodeProject.objects.PBXFileSystemSynchronizedRootGroup = {
            'group-key': {
              isa: 'PBXFileSystemSynchronizedRootGroup',
              path: undefined as unknown as string,
              sourceTree: 'SOURCE_ROOT',
            },
          };

          // -- Act --
          const files = xcodeProject.getSourceFilesForTarget('some-target');

          // -- Assert --
          expect(files).toEqual([]);
        });

        it('should exclude files in membership exceptions', () => {
          // -- Arrange --
          const xcodeProject = new XcodeProject(projectWithSynchronizedFolders);

          // The subfolder 1-1-1 is a synchronized root group containing two files:
          // - File-1-1-1-1.swift
          // - File-1-1-1-2.swift
          //
          // The membership exceptions are:
          // - File-1-1-1-2.swift
          //
          // The expected result is that File-1-1-1-1.swift is excluded from the build, but
          // included due to the membership exception.
          // The File-1-1-1-2.swift is excluded from the build due to the membership exception.

          // Pre-condition: File-1-1-1-1.swift exists
          const file1111 = path.join(
            xcodeProject.baseDir,
            'Group 1',
            'Subgroup 1-1',
            'Subfolder 1-1-1',
            'File-1-1-1-1.swift',
          );
          expect(fs.existsSync(file1111)).toBe(true);

          // Pre-condition: File-1-1-1-2.swift exists
          const file1112 = path.join(
            xcodeProject.baseDir,
            'Group 1',
            'Subgroup 1-1',
            'Subfolder 1-1-1',
            'File-1-1-1-2.swift',
          );
          expect(fs.existsSync(file1112)).toBe(true);

          // -- Act --
          const files = xcodeProject.getSourceFilesForTarget('Project');

          // -- Assert --
          // Known Issue:
          // The file `File-1-1-1-1.swift` is included in the source build phase, but not in the list of files.
          //
          // This is the group structure:
          // <main group> / Group 1 / Subgroup 1-1 / Subfolder 1-1-1 / File-1-1-1-1.swift
          //
          //  - <main group> is the root group
          //  - Group 1 is a group
          //  - Subgroup 1-1 is a nested group
          //  - Subfolder 1-1-1 is a synchronized root group
          //  - File-1-1-1-1.swift is a file in the synchronized root group Subfolder 1-1-1
          //
          // For no apparent reason, Xcode is picking up the file, but Group 1 is not mentioned anywhere other then the main group.
          // This would require us to consider every root group as a potential source of files, which seems excessive if a project has multiple targets.

          // expect(files).toContain(file1111);
          expect(files).not.toContain(file1112);
        });

        it('should return synchronized files and files in main group', () => {
          // -- Arrange --
          const xcodeProject = new XcodeProject(projectWithSynchronizedFolders);

          // -- Act --
          const files = xcodeProject.getSourceFilesForTarget('Project');

          // -- Assert --
          // The order is not guaranteed, so we need to check for each file individually
          // The order in this test case is the one displayed in the Xcode UI
          const group1DirPath = path.join(xcodeProject.baseDir, 'Group 1');
          const subgroup1_1DirPath = path.join(group1DirPath, 'Subgroup 1-1');
          const subgroup1_2DirPath = path.join(group1DirPath, 'Subgroup 1-2');
          const subgroup1_1_2DirPath = path.join(
            subgroup1_1DirPath,
            'Subgroup 1-1-2',
          );

          const sourcesDirPath = path.join(xcodeProject.baseDir, 'Sources');
          const subfolder1DirPath = path.join(sourcesDirPath, 'Subfolder 1');
          const subfolder2DirPath = path.join(sourcesDirPath, 'Subfolder 2');

          const groupRef1_3DirPath = path.join(
            xcodeProject.baseDir,
            'Group Reference 1-3',
          );

          expect(files).toContain(
            path.join(subgroup1_2DirPath, 'File-1-2-2.swift'),
          );
          expect(files).toContain(
            path.join(subfolder1DirPath, 'ContentView.swift'),
          );
          expect(files).toContain(
            path.join(
              subgroup1_2DirPath,
              'File-1-2-3--relative-to-group.swift',
            ),
          );
          expect(files).toContain(path.join(sourcesDirPath, 'MainApp.swift'));
          expect(files).toContain(path.join(subfolder2DirPath, 'File.swift'));

          // Absolute path
          expect(files).toContain(
            '/System/Library/CoreServices/SystemVersion.plist',
          );
          // Path relative to the SDK
          expect(files).toContain(
            '/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk/SDKSettings.plist',
          );
          // Path relative to the developer directory
          expect(files).toContain(
            '/Applications/Xcode.app/Contents/Developer/usr/bin/git',
          );
          // Path relative to the build products directory
          // NOT SUPPORTED YET

          // Path relative to the project
          expect(files).toContain(
            path.join(subgroup1_2DirPath, 'File-1-2-1.swift'),
          );
          expect(files).toContain(
            path.join(groupRef1_3DirPath, 'File-1-3-1.swift'),
          );
          expect(files).toContain(
            path.join(
              subgroup1_2DirPath,
              'File-1-2-3--relative-to-project.swift',
            ),
          );
          expect(files).toContain(
            path.join(subgroup1_1_2DirPath, 'File-1-1-2-1.swift'),
          );
          // Known Issue:
          // The file `File-1-1-1-1.swift` is included in the source build phase, but not in the list of files.
          //
          // This is the group structure:
          // <main group> / Group 1 / Subgroup 1-1 / Subfolder 1-1-1 / File-1-1-1-1.swift
          //
          //  - <main group> is the root group
          //  - Group 1 is a group
          //  - Subgroup 1-1 is a nested group
          //  - Subfolder 1-1-1 is a synchronized root group
          //  - File-1-1-1-1.swift is a file in the synchronized root group Subfolder 1-1-1
          //
          // For no apparent reason, Xcode is picking up the file, but Group 1 is not mentioned anywhere other then the main group.
          // This would require us to consider every root group as a potential source of files, which seems excessive if a project has multiple targets.

          // expect(files).toContain(
          //   path.join(
          //     xcodeProject.baseDir,
          //     'Group 1',
          //     'Subgroup 1-1',
          //     'Subfolder 1-1-1',
          //     'File-1-1-1-1.swift',
          //   ),
          // );

          // Assert that there are no other file paths in the list
          expect(files).toHaveLength(12);
        });
      });
    });

    describe('findFilesInSourceBuildPhase', () => {
      describe('when build phase is not found', () => {
        it('should return empty array', () => {
          // -- Arrange --
          const xcodeProject = new XcodeProject(singleTargetProjectPath);
          const nativeTargetId = 'D4E604CC2D50CEEC00CAB00F';
          const nativeTarget = xcodeProject.objects.PBXNativeTarget?.[
            nativeTargetId
          ] as PBXNativeTarget;
          nativeTarget.buildPhases = undefined;

          // -- Act --
          const files = xcodeProject.findFilesInSourceBuildPhase({
            id: nativeTargetId,
            obj: nativeTarget,
          });

          // -- Assert --
          expect(files).toEqual([]);
        });
      });

      describe('build phase files are undefined', () => {
        it('should return empty array', () => {
          // -- Arrange --
          const xcodeProject = new XcodeProject(projectWithSynchronizedFolders);
          const nativeTargetId = 'D4E604CC2D50CEEC00CAB00F';
          const nativeTarget = xcodeProject.objects.PBXNativeTarget?.[
            nativeTargetId
          ] as PBXNativeTarget;
          nativeTarget.buildPhases = [
            {
              value: 'build-phase-key',
            },
          ];
          xcodeProject.objects.PBXSourcesBuildPhase = {
            'build-phase-key': {
              isa: 'PBXSourcesBuildPhase',
              files: undefined,
            },
          };

          // -- Act --
          const files = xcodeProject.findFilesInSourceBuildPhase({
            id: nativeTargetId,
            obj: nativeTarget,
          });

          // -- Assert --
          expect(files).toEqual([]);
        });
      });

      describe('build phase files are empty', () => {
        it('should return empty array', () => {
          // -- Arrange --
          const xcodeProject = new XcodeProject(projectWithSynchronizedFolders);
          const nativeTargetId = 'D4E604CC2D50CEEC00CAB00F';
          const nativeTarget = xcodeProject.objects.PBXNativeTarget?.[
            nativeTargetId
          ] as PBXNativeTarget;
          nativeTarget.buildPhases = [
            {
              value: 'build-phase-key',
            },
          ];
          xcodeProject.objects.PBXSourcesBuildPhase = {
            'build-phase-key': {
              isa: 'PBXSourcesBuildPhase',
              files: [],
            },
          };

          // -- Act --
          const files = xcodeProject.findFilesInSourceBuildPhase({
            id: nativeTargetId,
            obj: nativeTarget,
          });

          // -- Assert --
          expect(files).toEqual([]);
        });
      });

      describe('build phase file is a comment', () => {
        it('should return empty array', () => {
          // -- Arrange --
          const xcodeProject = new XcodeProject(projectWithSynchronizedFolders);
          const nativeTargetId = 'D4E604CC2D50CEEC00CAB00F';
          const nativeTarget = xcodeProject.objects.PBXNativeTarget?.[
            nativeTargetId
          ] as PBXNativeTarget;
          nativeTarget.buildPhases = [
            {
              value: 'build-phase-key',
            },
          ];
          xcodeProject.objects.PBXSourcesBuildPhase = {
            'build-phase-key': 'this is a comment',
          };

          // Smoke test to ensure native target is defined
          expect(nativeTarget).toBeDefined();

          // -- Act --
          const files = xcodeProject.findFilesInSourceBuildPhase({
            id: nativeTargetId,
            obj: nativeTarget,
          });

          // -- Assert --
          expect(files).toEqual([]);
        });
      });

      describe('build phase file is not found', () => {
        it('should return empty array', () => {
          // -- Arrange --
          const xcodeProject = new XcodeProject(projectWithSynchronizedFolders);
          const nativeTargetId = 'D4E604CC2D50CEEC00CAB00F';
          const nativeTarget = xcodeProject.objects.PBXNativeTarget?.[
            nativeTargetId
          ] as PBXNativeTarget;
          nativeTarget.buildPhases = [
            {
              value: 'build-phase-key',
            },
          ];
          xcodeProject.objects.PBXSourcesBuildPhase = {
            'build-phase-key': {
              isa: 'PBXSourcesBuildPhase',
              files: [],
            },
          };

          // -- Act --
          const files = xcodeProject.findFilesInSourceBuildPhase({
            id: nativeTargetId,
            obj: nativeTarget,
          });

          // -- Assert --
          expect(files).toEqual([]);
        });
      });

      describe('build phase file reference is a comment', () => {
        it('should return empty array', () => {
          // -- Arrange --
          const xcodeProject = new XcodeProject(projectWithSynchronizedFolders);
          const nativeTargetId = 'D4E604CC2D50CEEC00CAB00F';
          const nativeTarget = xcodeProject.objects.PBXNativeTarget?.[
            nativeTargetId
          ] as PBXNativeTarget;
          nativeTarget.buildPhases = [
            {
              value: 'build-phase-key',
            },
          ];
          xcodeProject.objects.PBXSourcesBuildPhase = {
            'build-phase-key': {
              isa: 'PBXSourcesBuildPhase',
              files: [
                {
                  value: 'file-key',
                },
              ],
            },
          };
          xcodeProject.objects.PBXBuildFile = {
            'file-key': {
              isa: 'PBXBuildFile',
              fileRef: 'file-ref-key',
            },
          };
          xcodeProject.objects.PBXFileReference = {
            'file-ref-key': 'this is a comment',
          };

          // -- Act --
          const files = xcodeProject.findFilesInSourceBuildPhase({
            id: nativeTargetId,
            obj: nativeTarget,
          });

          // -- Assert --
          expect(files).toEqual([]);
        });
      });

      describe('build phase file reference has no path', () => {
        it('should be ignored', () => {
          // -- Arrange --
          const xcodeProject = new XcodeProject(projectWithSynchronizedFolders);
          const nativeTargetId = 'D4E604CC2D50CEEC00CAB00F';
          const nativeTarget = xcodeProject.objects.PBXNativeTarget?.[
            nativeTargetId
          ] as PBXNativeTarget;
          nativeTarget.buildPhases = [
            {
              value: 'build-phase-key',
            },
          ];
          xcodeProject.objects.PBXSourcesBuildPhase = {
            'build-phase-key': {
              isa: 'PBXSourcesBuildPhase',
              files: [
                {
                  value: 'file-key',
                },
              ],
            },
          };
          xcodeProject.objects.PBXBuildFile = {
            'file-key': {
              isa: 'PBXBuildFile',
              fileRef: 'file-ref-key',
            },
          };
          xcodeProject.objects.PBXFileReference = {
            'file-ref-key': {
              isa: 'PBXFileReference',
              path: undefined as unknown as string,
              sourceTree: 'SOURCE_ROOT',
            },
          };

          // -- Act --
          const files = xcodeProject.findFilesInSourceBuildPhase({
            id: nativeTargetId,
            obj: nativeTarget,
          });

          // -- Assert --
          expect(files).toEqual([]);
        });
      });

      describe('when file reference path contains doublequotes', () => {
        it('should be removed', () => {
          // -- Arrange --
          const xcodeProject = new XcodeProject(projectWithSynchronizedFolders);
          const nativeTargetId = 'D4E604CC2D50CEEC00CAB00F';
          const nativeTarget = xcodeProject.objects.PBXNativeTarget?.[
            nativeTargetId
          ] as PBXNativeTarget;
          nativeTarget.buildPhases = [
            {
              value: 'build-phase-key',
            },
          ];
          xcodeProject.objects.PBXSourcesBuildPhase = {
            'build-phase-key': {
              isa: 'PBXSourcesBuildPhase',
              files: [
                {
                  value: 'file-key',
                },
              ],
            },
          };
          xcodeProject.objects.PBXBuildFile = {
            'file-key': {
              isa: 'PBXBuildFile',
              fileRef: 'file-ref-key',
            },
          };
          xcodeProject.objects.PBXFileReference = {
            'file-ref-key': {
              isa: 'PBXFileReference',
              path: '"path/with/quotes.swift"',
              sourceTree: 'SOURCE_ROOT',
            },
          };

          // -- Act --
          const files = xcodeProject.findFilesInSourceBuildPhase({
            id: nativeTargetId,
            obj: nativeTarget,
          });

          // -- Assert --
          expect(files).toEqual([
            path.join(xcodeProject.baseDir, 'path/with/quotes.swift'),
          ]);
        });
      });

      it('should return all files in build phase', () => {
        // -- Arrange --
        const xcodeProject = new XcodeProject(projectWithSynchronizedFolders);
        const nativeTargetId = 'D4E604CC2D50CEEC00CAB00F';
        const nativeTarget = xcodeProject.objects.PBXNativeTarget?.[
          nativeTargetId
        ] as PBXNativeTarget;

        // -- Act --
        const files = xcodeProject.findFilesInSourceBuildPhase({
          id: nativeTargetId,
          obj: nativeTarget,
        });

        // -- Assert --
        // The list should reflect exactly the list of `files` in the `PBXSourcesBuildPhase` in the project.pbxproj file
        expect(files).toEqual([
          // Absolute paths
          '/System/Library/CoreServices/SystemVersion.plist',

          // Path relative to the build directory
          // NOT SUPPORTED YET

          // Path relative to the SDK
          '/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk/SDKSettings.plist',

          // Path relative to the developer directory
          '/Applications/Xcode.app/Contents/Developer/usr/bin/git',

          path.join(
            xcodeProject.baseDir,
            'Group 1',
            'Subgroup 1-2',
            'File-1-2-2.swift',
          ),
          path.join(
            xcodeProject.baseDir,
            'Group 1',
            'Subgroup 1-2',
            'File-1-2-3--relative-to-group.swift',
          ),
          path.join(
            xcodeProject.baseDir,
            'Group 1',
            'Subgroup 1-2',
            'File-1-2-1.swift',
          ),
          path.join(
            xcodeProject.baseDir,
            'Group 1',
            'Subgroup 1-1',
            'Subgroup 1-1-2',
            'File-1-1-2-1.swift',
          ),
          path.join(
            xcodeProject.baseDir,
            'Group Reference 1-3',
            'File-1-3-1.swift',
          ),
          path.join(
            xcodeProject.baseDir,
            'Group 1',
            'Subgroup 1-2',
            'File-1-2-3--relative-to-project.swift',
          ),
        ]);
      });
    });

    describe('findSourceBuildPhaseInTarget', () => {
      describe('when build phases are undefined', () => {
        it('should return undefined', () => {
          // -- Arrange --
          const xcodeProject = new XcodeProject(singleTargetProjectPath);
          const nativeTargetId = 'D4E604CC2D50CEEC00CAB00F';
          const nativeTarget = xcodeProject.objects.PBXNativeTarget?.[
            nativeTargetId
          ] as PBXNativeTarget;
          nativeTarget.buildPhases = undefined;

          // -- Act --
          const buildPhase =
            xcodeProject.findSourceBuildPhaseInTarget(nativeTarget);

          // -- Assert --
          expect(buildPhase).toBeUndefined();
        });
      });

      describe('when build phases are empty', () => {
        it('should return undefined', () => {
          // -- Arrange --
          const xcodeProject = new XcodeProject(singleTargetProjectPath);
          const nativeTargetId = 'D4E604CC2D50CEEC00CAB00F';
          const nativeTarget = xcodeProject.objects.PBXNativeTarget?.[
            nativeTargetId
          ] as PBXNativeTarget;
          nativeTarget.buildPhases = [];

          // -- Act --
          const buildPhase =
            xcodeProject.findSourceBuildPhaseInTarget(nativeTarget);

          // -- Assert --
          expect(buildPhase).toBeUndefined();
        });
      });

      describe('when referenced build phase is not found', () => {
        it('should ignore it', () => {
          // -- Arrange --
          const xcodeProject = new XcodeProject(singleTargetProjectPath);
          const nativeTargetId = 'D4E604CC2D50CEEC00CAB00F';
          const nativeTarget = xcodeProject.objects.PBXNativeTarget?.[
            nativeTargetId
          ] as PBXNativeTarget;
          nativeTarget.buildPhases = [
            {
              value: 'build-phase-key',
            },
          ];
          xcodeProject.objects.PBXSourcesBuildPhase = {};

          // -- Act --
          const buildPhase =
            xcodeProject.findSourceBuildPhaseInTarget(nativeTarget);

          // -- Assert --
          expect(buildPhase).toBeUndefined();
        });
      });

      describe('when referenced build phase is found', () => {
        it('should return the build phase', () => {
          // -- Arrange --
          const xcodeProject = new XcodeProject(singleTargetProjectPath);
          const nativeTargetId = 'D4E604CC2D50CEEC00CAB00F';
          const nativeTarget = xcodeProject.objects.PBXNativeTarget?.[
            nativeTargetId
          ] as PBXNativeTarget;

          // -- Act --
          const buildPhase =
            xcodeProject.findSourceBuildPhaseInTarget(nativeTarget);

          // -- Assert --
          expect(buildPhase).toEqual({
            id: 'D4E604C92D50CEEC00CAB00F',
            obj: {
              isa: 'PBXSourcesBuildPhase',
              files: [],
              buildActionMask: 2147483647,
              runOnlyForDeploymentPostprocessing: 0,
            },
          });
        });
      });
    });

    describe('findFilesInSynchronizedRootGroups', () => {
      describe('when synchronized root groups are undefined', () => {
        it('should return empty array', () => {
          // -- Arrange --
          const xcodeProject = new XcodeProject(singleTargetProjectPath);
          const nativeTargetId = 'D4E604CC2D50CEEC00CAB00F';
          const nativeTarget = xcodeProject.objects.PBXNativeTarget?.[
            nativeTargetId
          ] as PBXNativeTarget;
          nativeTarget.fileSystemSynchronizedGroups = undefined;

          // -- Act --
          const files = xcodeProject.findFilesInSynchronizedRootGroups({
            id: nativeTargetId,
            obj: nativeTarget,
          });

          // -- Assert --
          expect(files).toEqual([]);
        });
      });

      describe('when synchronized root groups are empty', () => {
        it('should return empty array', () => {
          // -- Arrange --
          const xcodeProject = new XcodeProject(singleTargetProjectPath);
          const nativeTargetId = 'D4E604CC2D50CEEC00CAB00F';
          const nativeTarget = xcodeProject.objects.PBXNativeTarget?.[
            nativeTargetId
          ] as PBXNativeTarget;
          nativeTarget.fileSystemSynchronizedGroups = [];

          // -- Act --
          const files = xcodeProject.findFilesInSynchronizedRootGroups({
            id: nativeTargetId,
            obj: nativeTarget,
          });

          // -- Assert --
          expect(files).toEqual([]);
        });
      });

      describe('when synchronized root groups are not found', () => {
        it('should ignore files in them', () => {
          // -- Arrange --
          const xcodeProject = new XcodeProject(projectWithSynchronizedFolders);
          const nativeTargetId = 'D4E604CC2D50CEEC00CAB00F';
          const nativeTarget = xcodeProject.objects.PBXNativeTarget?.[
            nativeTargetId
          ] as PBXNativeTarget;

          // Add an invalid group reference to the native target
          nativeTarget.fileSystemSynchronizedGroups = [
            ...(nativeTarget.fileSystemSynchronizedGroups || []),
            {
              value: 'invalid-group-key',
            },
          ];

          // -- Act --
          const files = xcodeProject.findFilesInSynchronizedRootGroups({
            id: nativeTargetId,
            obj: nativeTarget,
          });

          // -- Assert --
          expect(files).not.toContain(
            path.join(
              xcodeProject.baseDir,
              'Sources',
              'Subfolder 1',
              'Excluded-File.swift',
            ),
          );
        });
      });
    });

    describe('addUploadSymbolsScript', () => {
      let sourceProjectPath: string;
      let tempProjectPath: string;
      let xcodeProject: XcodeProject;

      beforeEach(() => {
        const tempDir = fs.mkdtempSync(
          path.join(os.tmpdir(), 'add-upload-symbols-script'),
        );

        sourceProjectPath = singleTargetProjectPath;
        tempProjectPath = path.resolve(tempDir, 'project.pbxproj');

        fs.copyFileSync(sourceProjectPath, tempProjectPath);
        xcodeProject = new XcodeProject(tempProjectPath);
      });

      describe('when target is not found', () => {
        it('should return early', () => {
          // -- Act --
          xcodeProject.addUploadSymbolsScript({
            sentryProject: projectData,
            targetName: 'NonExistentTarget',
            uploadSource: true,
          });

          // -- Assert --
          // Verify that no shell script build phases were added
          expect(xcodeProject.objects.PBXShellScriptBuildPhase).toBeUndefined();
        });
      });

      describe('when target has existing Sentry build phase', () => {
        beforeEach(() => {
          // Set up a target with an existing Sentry build phase
          xcodeProject.objects.PBXNativeTarget = {
            'target-key': {
              isa: 'PBXNativeTarget',
              name: 'TestTarget',
              buildPhases: [
                {
                  value: 'existing-sentry-phase',
                  comment: 'Upload Debug Symbols to Sentry',
                },
              ],
            },
          };

          xcodeProject.objects.PBXShellScriptBuildPhase = {
            'existing-sentry-phase': {
              isa: 'PBXShellScriptBuildPhase',
              shellScript: '"echo sentry-cli upload-dsym"',
              buildActionMask: 2147483647,
              files: [],
              inputPaths: [],
              outputPaths: [],
              runOnlyForDeploymentPostprocessing: 0,
              shellPath: '/bin/sh',
            },
          };
        });

        it('should update existing build phase instead of adding new one', () => {
          // -- Act --
          xcodeProject.addUploadSymbolsScript({
            sentryProject: projectData,
            targetName: 'TestTarget',
            uploadSource: true,
          });

          // -- Assert --
          // Should still have only one build phase (the updated one)
          const buildPhases = Object.keys(
            xcodeProject.objects.PBXShellScriptBuildPhase || {},
          );
          expect(
            buildPhases.filter((key) => !key.endsWith('_comment')),
          ).toHaveLength(1);

          // The existing phase should be updated with new script content
          const updatedPhase =
            xcodeProject.objects.PBXShellScriptBuildPhase?.[
              'existing-sentry-phase'
            ];
          expect(updatedPhase).toBeDefined();
          expect(
            (updatedPhase as PBXShellScriptBuildPhase)?.shellScript,
          ).toContain('sentry-cli');
        });
      });

      describe('orphaned build phase cleanup', () => {
        beforeEach(() => {
          // Set up targets with orphaned build phase references
          xcodeProject.objects.PBXNativeTarget = {
            'target-1': {
              isa: 'PBXNativeTarget',
              name: 'Target1',
              buildPhases: [
                {
                  value: 'orphaned-phase-1',
                  comment: 'Upload Debug Symbols to Sentry',
                },
                {
                  value: 'valid-phase',
                  comment: 'Sources',
                },
              ],
            },
            'target-2': {
              isa: 'PBXNativeTarget',
              name: 'Target2',
              buildPhases: [
                {
                  value: 'orphaned-phase-2',
                  comment: 'Upload Debug Symbols to Sentry',
                },
              ],
            },
          };

          // PBXShellScriptBuildPhase doesn't have the orphaned phases
          xcodeProject.objects.PBXShellScriptBuildPhase = {
            'valid-phase': {
              isa: 'PBXShellScriptBuildPhase',
              shellScript: '"echo valid"',
              buildActionMask: 2147483647,
              files: [],
              inputPaths: [],
              outputPaths: [],
              runOnlyForDeploymentPostprocessing: 0,
              shellPath: '/bin/sh',
            },
          };
        });

        it('should remove orphaned build phase references from all targets', () => {
          // -- Act --
          xcodeProject.addUploadSymbolsScript({
            sentryProject: projectData,
            targetName: 'Target1',
            uploadSource: true,
          });

          // -- Assert --
          const target1 = xcodeProject.objects.PBXNativeTarget?.[
            'target-1'
          ] as PBXNativeTarget;
          const target2 = xcodeProject.objects.PBXNativeTarget?.[
            'target-2'
          ] as PBXNativeTarget;

          // Target1 should only have the valid phase left, plus the new Sentry phase
          expect(target1?.buildPhases).not.toEqual(
            expect.arrayContaining([
              expect.objectContaining({ value: 'orphaned-phase-1' }),
            ]),
          );
          expect(target1?.buildPhases).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ value: 'valid-phase' }),
            ]),
          );

          // Target2 should have orphaned phase removed and be empty
          expect(target2?.buildPhases).not.toEqual(
            expect.arrayContaining([
              expect.objectContaining({ value: 'orphaned-phase-2' }),
            ]),
          );
        });
      });
    });

    describe('addUploadSymbolsScript edge cases', () => {
      let xcodeProject: XcodeProject;

      beforeEach(() => {
        xcodeProject = new XcodeProject(singleTargetProjectPath);
      });

      describe('when target is not found', () => {
        it('should handle gracefully without throwing', () => {
          // -- Act & Assert --
          expect(() => {
            xcodeProject.addUploadSymbolsScript({
              sentryProject: projectData,
              targetName: 'NonExistentTarget',
              uploadSource: true,
            });
          }).not.toThrow();
        });
      });
    });

    describe('addScriptBuildPhase method coverage', () => {
      let sourceProjectPath: string;
      let tempProjectPath: string;
      let xcodeProject: XcodeProject;

      beforeEach(() => {
        const tempDir = fs.mkdtempSync(
          path.join(os.tmpdir(), 'add-script-build-phase'),
        );

        sourceProjectPath = singleTargetProjectPath;
        tempProjectPath = path.resolve(tempDir, 'project.pbxproj');

        fs.copyFileSync(sourceProjectPath, tempProjectPath);
        xcodeProject = new XcodeProject(tempProjectPath);
      });

      describe('when PBXShellScriptBuildPhase does not exist initially', () => {
        it('should initialize PBXShellScriptBuildPhase and add build phase', () => {
          // -- Arrange --
          // Set PBXShellScriptBuildPhase to empty to test initialization path
          delete xcodeProject.objects.PBXShellScriptBuildPhase;
          const targetKey = 'D4E604CC2D50CEEC00CAB00F';

          // -- Act --
          const buildPhaseId = xcodeProject.addScriptBuildPhase(
            targetKey,
            'Test Script',
            'echo "test"',
            ['input.txt'],
          );

          // -- Assert --
          expect(xcodeProject.objects.PBXShellScriptBuildPhase).toBeDefined();
          expect(buildPhaseId).toMatch(/^[A-F0-9]{24}$/i);

          const buildPhase =
            xcodeProject.objects.PBXShellScriptBuildPhase?.[buildPhaseId];
          expect(buildPhase).toBeDefined();
          expect(typeof buildPhase).not.toBe('string');
        });
      });

      describe('when target does not exist', () => {
        it('should still create build phase but not add to target', () => {
          // -- Arrange --
          const invalidTargetKey = 'INVALID_TARGET_KEY';

          // -- Act --
          const buildPhaseId = xcodeProject.addScriptBuildPhase(
            invalidTargetKey,
            'Test Script',
            'echo "test"',
            [],
          );

          // -- Assert --
          expect(buildPhaseId).toMatch(/^[A-F0-9]{24}$/i);

          // Build phase should be created in PBXShellScriptBuildPhase
          const buildPhase =
            xcodeProject.objects.PBXShellScriptBuildPhase?.[buildPhaseId];
          expect(buildPhase).toBeDefined();

          // But target should not have the build phase added since target doesn't exist
          const target =
            xcodeProject.objects.PBXNativeTarget?.[invalidTargetKey];
          expect(target).toBeUndefined();
        });
      });

      describe('when target has no buildPhases array', () => {
        it('should not add build phase to target but should create build phase object', () => {
          // -- Arrange --
          const targetKey = 'D4E604CC2D50CEEC00CAB00F';
          const target = xcodeProject.objects.PBXNativeTarget?.[targetKey];
          if (target && typeof target !== 'string') {
            // Remove buildPhases to test the undefined case
            const targetWithoutBuildPhases = target as unknown as {
              buildPhases: undefined;
            };
            delete targetWithoutBuildPhases.buildPhases;
          }

          // -- Act --
          const buildPhaseId = xcodeProject.addScriptBuildPhase(
            targetKey,
            'Test Script',
            'echo "test"',
            [],
          );

          // -- Assert --
          expect(buildPhaseId).toMatch(/^[A-F0-9]{24}$/i);

          // Build phase should be created
          const buildPhase =
            xcodeProject.objects.PBXShellScriptBuildPhase?.[buildPhaseId];
          expect(buildPhase).toBeDefined();

          // Target should exist but buildPhases should still be undefined
          const updatedTarget = xcodeProject.objects.PBXNativeTarget?.[
            targetKey
          ] as PBXNativeTarget | undefined;
          expect(updatedTarget).toBeDefined();
          expect(updatedTarget?.buildPhases).toBeUndefined();
        });
      });
    });

    describe('updateScriptBuildPhase method coverage', () => {
      let sourceProjectPath: string;
      let tempProjectPath: string;
      let xcodeProject: XcodeProject;

      beforeEach(() => {
        const tempDir = fs.mkdtempSync(
          path.join(os.tmpdir(), 'update-script-build-phase'),
        );

        sourceProjectPath = singleTargetProjectPath;
        tempProjectPath = path.resolve(tempDir, 'project.pbxproj');

        fs.copyFileSync(sourceProjectPath, tempProjectPath);
        xcodeProject = new XcodeProject(tempProjectPath);
      });

      describe('when build phase does not exist', () => {
        it('should debug and return early', () => {
          // -- Act & Assert --
          expect(() => {
            xcodeProject.updateScriptBuildPhase(
              'NONEXISTENT_BUILD_PHASE',
              'echo "updated"',
              ['input.txt'],
            );
          }).not.toThrow();
        });
      });

      describe('when build phase is a string comment', () => {
        it('should debug and return early', () => {
          // -- Arrange --
          xcodeProject.objects.PBXShellScriptBuildPhase = {
            'test-id': 'This is a comment string',
          };

          // -- Act & Assert --
          expect(() => {
            xcodeProject.updateScriptBuildPhase('test-id', 'echo "updated"', [
              'input.txt',
            ]);
          }).not.toThrow();
        });
      });

      describe('when build phase exists and is valid', () => {
        it('should update the build phase successfully', () => {
          // -- Arrange --
          const buildPhaseId = 'test-build-phase-id';
          xcodeProject.objects.PBXShellScriptBuildPhase = {
            [buildPhaseId]: {
              isa: 'PBXShellScriptBuildPhase',
              shellScript: '"echo \\"old script\\""',
              inputPaths: ['old-input.txt'],
              shellPath: '/bin/sh',
              buildActionMask: 2147483647,
              files: [],
              outputPaths: [],
              runOnlyForDeploymentPostprocessing: 0,
            },
          };

          // -- Act --
          xcodeProject.updateScriptBuildPhase(
            buildPhaseId,
            'echo "new script"',
            ['new-input.txt'],
          );

          // -- Assert --
          const buildPhase = xcodeProject.objects.PBXShellScriptBuildPhase?.[
            buildPhaseId
          ] as PBXShellScriptBuildPhase;
          expect(buildPhase).toBeDefined();
          expect(buildPhase?.shellScript).toBe('"echo \\"new script\\""');
          expect(buildPhase?.inputPaths).toEqual(['new-input.txt']);
          expect(buildPhase?.shellPath).toBe('/bin/sh');
        });
      });
    });

    describe('addUploadSymbolsScript method comprehensive coverage', () => {
      let sourceProjectPath: string;
      let tempProjectPath: string;
      let xcodeProject: XcodeProject;

      beforeEach(() => {
        const tempDir = fs.mkdtempSync(
          path.join(os.tmpdir(), 'add-upload-symbols-comprehensive'),
        );

        sourceProjectPath = singleTargetProjectPath;
        tempProjectPath = path.resolve(tempDir, 'project.pbxproj');

        fs.copyFileSync(sourceProjectPath, tempProjectPath);
        xcodeProject = new XcodeProject(tempProjectPath);
      });

      describe('when PBXShellScriptBuildPhase does not exist initially', () => {
        it('should initialize PBXShellScriptBuildPhase and add new build phase', () => {
          // -- Arrange --
          delete xcodeProject.objects.PBXShellScriptBuildPhase;

          // -- Act --
          xcodeProject.addUploadSymbolsScript({
            sentryProject: projectData,
            targetName: 'Project',
            uploadSource: true,
          });

          // -- Assert --
          expect(xcodeProject.objects.PBXShellScriptBuildPhase).toBeDefined();

          // Should have created a new build phase
          const buildPhases = Object.keys(
            xcodeProject.objects.PBXShellScriptBuildPhase || {},
          );
          const actualBuildPhases = buildPhases.filter(
            (key) => !key.endsWith('_comment'),
          );
          expect(actualBuildPhases.length).toBeGreaterThan(0);
        });
      });

      describe('when target has buildPhases but no existing Sentry script', () => {
        it('should iterate through buildPhases and add new script', () => {
          // -- Arrange --
          // Ensure target has buildPhases but none contain sentry-cli
          const targetKey = 'D4E604CC2D50CEEC00CAB00F';
          const target = xcodeProject.objects.PBXNativeTarget?.[targetKey];
          if (target && typeof target !== 'string') {
            target.buildPhases = [
              { value: 'some-other-phase', comment: 'Sources' },
              { value: 'another-phase', comment: 'Frameworks' },
            ];
          }

          // Ensure PBXShellScriptBuildPhase exists but without sentry-cli scripts
          xcodeProject.objects.PBXShellScriptBuildPhase = {
            'some-other-phase': {
              isa: 'PBXShellScriptBuildPhase',
              shellScript: '"echo \\"other script\\""',
              buildActionMask: 2147483647,
              files: [],
              inputPaths: [],
              outputPaths: [],
              runOnlyForDeploymentPostprocessing: 0,
              shellPath: '/bin/sh',
            },
            'another-phase': {
              isa: 'PBXShellScriptBuildPhase',
              shellScript: '"echo \\"another script\\""',
              buildActionMask: 2147483647,
              files: [],
              inputPaths: [],
              outputPaths: [],
              runOnlyForDeploymentPostprocessing: 0,
              shellPath: '/bin/sh',
            },
          };

          // -- Act --
          xcodeProject.addUploadSymbolsScript({
            sentryProject: projectData,
            targetName: 'Project',
            uploadSource: true,
          });

          // -- Assert --
          // Should have added a new Sentry build phase (calls addScriptBuildPhase path)
          const buildPhases = Object.keys(
            xcodeProject.objects.PBXShellScriptBuildPhase || {},
          );
          const actualBuildPhases = buildPhases.filter(
            (key) => !key.endsWith('_comment'),
          );
          expect(actualBuildPhases.length).toBeGreaterThan(2); // Should have more than the original 2

          // Find the new Sentry script
          const sentryPhase = actualBuildPhases.find((phaseId) => {
            const phase =
              xcodeProject.objects.PBXShellScriptBuildPhase?.[phaseId];
            return (
              phase &&
              typeof phase !== 'string' &&
              phase.shellScript?.includes('sentry-cli')
            );
          });
          expect(sentryPhase).toBeDefined();
        });
      });

      describe('when target has no buildPhases', () => {
        it('should skip the buildPhases iteration and add new script', () => {
          // -- Arrange --
          const targetKey = 'D4E604CC2D50CEEC00CAB00F';
          const target = xcodeProject.objects.PBXNativeTarget?.[targetKey];
          if (target && typeof target !== 'string') {
            // Set buildPhases to undefined to test the skip path
            target.buildPhases = undefined;
          }

          // -- Act --
          xcodeProject.addUploadSymbolsScript({
            sentryProject: projectData,
            targetName: 'Project',
            uploadSource: true,
          });

          // -- Assert --
          // Should have added a new Sentry build phase via the else branch (addScriptBuildPhase)
          const buildPhases = Object.keys(
            xcodeProject.objects.PBXShellScriptBuildPhase || {},
          );
          const actualBuildPhases = buildPhases.filter(
            (key) => !key.endsWith('_comment'),
          );
          expect(actualBuildPhases.length).toBeGreaterThan(0);

          // Find the new Sentry script
          const sentryPhase = actualBuildPhases.find((phaseId) => {
            const phase =
              xcodeProject.objects.PBXShellScriptBuildPhase?.[phaseId];
            return (
              phase &&
              typeof phase !== 'string' &&
              phase.shellScript?.includes('sentry-cli')
            );
          });
          expect(sentryPhase).toBeDefined();
        });
      });
    });
  });
});
