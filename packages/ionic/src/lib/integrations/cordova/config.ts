import { prettyPath } from '@ionic/cli-framework/utils/format';
import { readPackageJsonFile } from '@ionic/cli-framework/utils/node';
import { readFile, writeFile } from '@ionic/utils-fs';
import * as Debug from 'debug';
import * as et from 'elementtree';
import * as path from 'path';

import { CordovaPackageJson, ProjectIntegration, ResourcesPlatform } from '../../../definitions';
import { isCordovaPackageJson } from '../../../guards';
import { failure, input, strong } from '../../color';
import { FatalException } from '../../errors';
import { shortid } from '../../utils/uuid';

const debug = Debug('ionic:lib:integrations:cordova:config');

export interface ConfiguredPlatform {
  name: string;
  spec?: string;
}

export class ConfigConfig {
  protected _doc?: et.ElementTree;
  protected _pkg?: CordovaPackageJson;
  protected _sessionid?: string;
  protected saving = false;

  constructor(readonly configXmlPath: string, readonly packageJsonPath: string) {}

  get doc(): et.ElementTree {
    if (!this._doc) {
      throw new Error('No doc loaded.');
    }

    return this._doc;
  }

  get pkg(): CordovaPackageJson {
    if (!this._pkg) {
      throw new Error('No package.json loaded.');
    }

    return this._pkg;
  }

  get sessionid(): string {
    if (!this._sessionid) {
      throw new Error('No doc loaded.');
    }

    return this._sessionid;
  }

  static async load(configXmlPath: string, packageJsonPath: string): Promise<ConfigConfig> {
    if (!configXmlPath || !packageJsonPath) {
      throw new Error('Must supply file paths for config.xml and package.json.');
    }

    const conf = new ConfigConfig(configXmlPath, packageJsonPath);
    await conf.reload();

    return conf;
  }

  protected async reload(): Promise<void> {
    const configXml = await readFile(this.configXmlPath, { encoding: 'utf8' });

    if (!configXml) {
      throw new Error(`Cannot load empty config.xml file.`);
    }

    try {
      this._doc = et.parse(configXml);
      this._sessionid = shortid();
    } catch (e) {
      throw new Error(`Cannot parse config.xml file: ${e.stack ? e.stack : e}`);
    }

    const packageJson = await readPackageJsonFile(this.packageJsonPath);

    if (isCordovaPackageJson(packageJson)) {
      this._pkg = packageJson;
    } else {
      this._pkg = { ...packageJson, cordova: { platforms: [], plugins: {} } };
      debug('Invalid package.json for Cordova. Missing or invalid Cordova entries in %O', this.packageJsonPath);
    }
  }

  async save(): Promise<void> {
    if (!this.saving) {
      this.saving = true;
      await writeFile(this.configXmlPath, this.write(), { encoding: 'utf8' });
      this.saving = false;
    }
  }

  setName(name: string): void {
    const root = this.doc.getroot();
    let nameNode = root.find('name');

    if (!nameNode) {
      nameNode = et.SubElement(root, 'name', {});
    }

    nameNode.text = name;
  }

  setBundleId(bundleId: string): void {
    const root = this.doc.getroot();
    root.set('id', bundleId);
  }

  getBundleId(): string | undefined {
    const root = this.doc.getroot();
    return root.get('id');
  }

  /**
   * Update config.xml content src to be a dev server url. As part of this
   * backup the original content src for a reset to occur at a later time.
   */
  writeContentSrc(newSrc: string): void {
    const root = this.doc.getroot();
    let contentElement = root.find('content');

    if (!contentElement) {
      contentElement = et.SubElement(root, 'content', { src: 'index.html' });
    }

    contentElement.set('original-src', contentElement.get('src'));
    contentElement.set('src', newSrc);

    let navElement = root.find(`allow-navigation[@href='${newSrc}']`);

    if (!navElement) {
      navElement = et.SubElement(root, 'allow-navigation', { sessionid: this.sessionid, href: newSrc });
    }
  }

  /**
   * Set config.xml src url back to its original url
   */
  resetContentSrc() {
    const root = this.doc.getroot();
    let contentElement = root.find('content');

    if (!contentElement) {
      contentElement = et.SubElement(root, 'content', { src: 'index.html' });
    }

    const originalSrc = contentElement.get('original-src');

    if (originalSrc) {
      contentElement.set('src', originalSrc);
      delete contentElement.attrib['original-src'];
    }

    const navElements = root.findall(`allow-navigation[@sessionid='${this.sessionid}']`);

    for (const navElement of navElements) {
      root.remove(navElement);
    }
  }

  getPreference(prefName: string): string | undefined {
    const root = this.doc.getroot();

    const preferenceElement = root.find(`preference[@name='${prefName}']`);

    if (!preferenceElement) {
      return undefined;
    }

    const value = preferenceElement.get('value');

    if (!value) {
      return undefined;
    }

    return value;
  }

  getProjectInfo(): { id: string; name: string; version: string; } {
    const root = this.doc.getroot();

    let id = root.get('id');

    if (!id) {
      id = '';
    }

    let version = root.get('version');

    if (!version) {
      version = '';
    }

    let nameElement = root.find('name');

    if (!nameElement) {
      nameElement = et.SubElement(root, 'name', {});
    }

    if (!nameElement.text) {
      nameElement.text = 'MyApp';
    }

    const name = nameElement.text.toString();

    return { id, name, version };
  }

  getConfiguredPlatforms(): ConfiguredPlatform[] {
    const deps: { [key: string]: string | undefined; } = { ...this.pkg.devDependencies, ...this.pkg.dependencies };

    return this.pkg.cordova.platforms.map(platform => ({
      name: platform,
      spec: deps[`cordova-${platform}`],
    }));
  }

  ensurePlatformImages(platform: string, resourcesPlatform: ResourcesPlatform): void {
    const root = this.doc.getroot();
    const orientation = this.getPreference('Orientation') || 'default';

    for (const imgName in resourcesPlatform) {
      const imgType = resourcesPlatform[imgName];
      let platformElement = root.find(`platform[@name='${platform}']`);

      if (!platformElement) {
        platformElement = et.SubElement(root, 'platform', { name: platform });
      }

      const images = imgType.images.filter(img => orientation === 'default' || typeof img.orientation === 'undefined' || img.orientation === orientation);

      for (const image of images) {
        // We use forward slashes, (not path.join) here to provide
        // cross-platform compatibility for paths.
        const imgPath = ['resources', platform, imgType.nodeName, image.name].join('/'); // TODO: hard-coded 'resources' dir
        let imgElement = platformElement.find(`${imgType.nodeName}[@src='${imgPath}']`);

        if (!imgElement) {
          imgElement = platformElement.find(`${imgType.nodeName}[@src='${imgPath.split('/').join('\\')}']`);
        }

        if (!imgElement) {
          const attrs: { [key: string]: string } = {};

          for (const attr of imgType.nodeAttributes) {
            let v = (image as any)[attr]; // TODO

            if (attr === 'src') {
              v = imgPath;
            }

            attrs[attr] = v;
          }

          imgElement = et.SubElement(platformElement, imgType.nodeName, attrs);
        }

        imgElement.set('src', imgPath);
      }
    }
  }

  ensureSplashScreenPreferences(): void {
    const root = this.doc.getroot();

    let splashScreenPrefElement = root.find(`preference[@name='SplashScreen']`);

    if (!splashScreenPrefElement) {
      splashScreenPrefElement = et.SubElement(root, 'preference', { name: 'SplashScreen', value: 'screen' });
    }

    let splashShowOnlyFirstTimePrefElement = root.find(`preference[@name='SplashShowOnlyFirstTime']`);

    if (!splashShowOnlyFirstTimePrefElement) {
      splashShowOnlyFirstTimePrefElement = et.SubElement(root, 'preference', { name: 'SplashShowOnlyFirstTime', value: 'false' });
    }

    let splashScreenDelayPrefElement = root.find(`preference[@name='SplashScreenDelay']`);

    if (!splashScreenDelayPrefElement) {
      splashScreenDelayPrefElement = et.SubElement(root, 'preference', { name: 'SplashScreenDelay', value: '3000' });
    }
  }

  protected write(): string {
    // Cordova hard codes an indentation of 4 spaces, so we'll follow.
    const contents = this.doc.write({ indent: 4 });

    return contents;
  }
}

export async function loadCordovaConfig(integration: Required<ProjectIntegration>): Promise<ConfigConfig> {
  const configXmlPath = path.resolve(integration.root, 'config.xml');
  const packageJsonPath = path.resolve(integration.root, 'package.json');

  debug('Loading Cordova Config (config.xml: %O, package.json: %O)', configXmlPath, packageJsonPath);

  try {
    return await ConfigConfig.load(configXmlPath, packageJsonPath);
  } catch (e) {
    const msg = e.code === 'ENOENT'
      ? (
          `Could not find necessary file(s): ${strong('config.xml')}, ${strong('package.json')}.\n\n` +
          ` - ${strong(prettyPath(configXmlPath))}\n` +
          ` - ${strong(prettyPath(packageJsonPath))}\n\n` +
          `You can re-add the Cordova integration with the following command: ${input('ionic integrations enable cordova --add')}`
        )
      : failure(e.stack ? e.stack : e);

    throw new FatalException(
      `Cannot load Cordova config.\n` +
      `${msg}`
    );
  }
}
